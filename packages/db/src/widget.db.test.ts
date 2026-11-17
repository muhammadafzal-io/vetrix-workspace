// Booking widget on the sample clinic, inside a transaction that is rolled back.
import { describe, expect, it } from "vitest";
import { Pool } from "@neondatabase/serverless";
import { RuleViolationError, ValidationError } from "@vetrix/domain";
import { startFrontDesk } from "./front-desk";
import {
  saveWidgetSettings,
  setServiceBookableOnline,
  startWidgetCode,
  verifyWidgetCode,
  widgetBook,
  widgetClinic,
  widgetMe,
  widgetRegister,
  widgetServices,
  widgetSession,
  widgetTimes,
} from "./widget";
import type { SqlClient } from "./sql-client";

const url = process.env.CLINIC_DATABASE_URL_DEV;
const staff = { type: "staff" as const, id: null };

/** A pool for startFrontDesk on the open test connection: its transaction becomes a savepoint, so everything still rolls back. */
const asPool = (db: SqlClient) => {
  const map: Record<string, string> = { BEGIN: "SAVEPOINT fd", COMMIT: "RELEASE SAVEPOINT fd", ROLLBACK: "ROLLBACK TO SAVEPOINT fd" };
  const query = ((text: string, params?: unknown[]) => db.query(map[text] ?? text, params)) as SqlClient["query"];
  return { query, connect: async () => ({ query, release: () => {} }) };
};

describe.skipIf(!url)("booking widget on the clinic database", () => {
  it("texts a code, signs a client in, books a routine visit once, and keeps sick visits and surgery off", async () => {
    const pool = new Pool({ connectionString: url, max: 1 });
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const loc = (await db.query<{ id: string; timezone: string }>(`SELECT id, timezone FROM locations ORDER BY name LIMIT 1`)).rows[0]!;
      await saveWidgetSettings(db, { locationId: loc.id, actor: staff }, { enabled: true, origins: ["https://happypaws.test"] });
      const now = Date.now();
      const clinic = await widgetClinic(db, loc.id, now);
      expect(clinic?.origins).toEqual(["https://happypaws.test"]);

      // A client who accepts texts and has an active dog.
      const c = (await db.query<{ id: string; mobile: string }>(
        `SELECT c.id, c.mobile FROM clients c WHERE c.location_id = $1 AND c.sms_consent
           AND NOT EXISTS (SELECT 1 FROM client_flags f WHERE f.client_id = c.id)
           AND EXISTS (SELECT 1 FROM patients p WHERE p.client_id = c.id AND p.status = 'active' AND p.species = 'dog')
         ORDER BY c.last_name LIMIT 1`,
        [loc.id],
      )).rows[0]!;

      const sent = await startWidgetCode(db, { locationId: loc.id, mobile: c.mobile, now });
      expect(sent.status).toBe("sent");
      if (sent.status !== "sent") return;
      expect(sent.code).toMatch(/^\d{6}$/);
      // Only a hash is stored.
      const stored = (await db.query<{ code_hash: string }>(`SELECT code_hash FROM widget_verifications WHERE mobile = $1 ORDER BY created_at DESC LIMIT 1`, [c.mobile])).rows[0]!;
      expect(stored.code_hash).not.toContain(sent.code);
      // A second code straight away must wait.
      expect((await startWidgetCode(db, { locationId: loc.id, mobile: c.mobile, now: now + 1000 })).status).toBe("wait");

      const wrong = sent.code === "000000" ? "111111" : "000000";
      expect(await verifyWidgetCode(db, { locationId: loc.id, mobile: c.mobile, code: wrong, now })).toEqual({ status: "wrong", triesLeft: 4 });
      const ok = await verifyWidgetCode(db, { locationId: loc.id, mobile: c.mobile, code: sent.code, now });
      expect(ok.status).toBe("ok");
      if (ok.status !== "ok") return;
      expect(ok.session.clientId).toBe(c.id);
      // A code works once.
      expect((await verifyWidgetCode(db, { locationId: loc.id, mobile: c.mobile, code: sent.code, now })).status).toBe("expired");
      // Sessions expire.
      expect(await widgetSession(db, { locationId: loc.id, token: ok.token, now: now + 31 * 60_000 })).toBeNull();
      const session = (await widgetSession(db, { locationId: loc.id, token: ok.token, now }))!;

      const me = await widgetMe(db, { locationId: loc.id, clientId: c.id, now, timezone: loc.timezone });
      const dog = me.pets.find((p) => p.species === "dog")!;
      expect(dog).toBeTruthy();

      const services = await widgetServices(db, { locationId: loc.id, species: "dog", newPatient: false });
      const ids = services.map((s) => s.packServiceId);
      expect(ids).toContain("wellness_exam");
      expect(ids).not.toContain("sick_visit");
      expect(ids).not.toContain("spay_canine");
      expect(ids).not.toContain("wellness_exam_new");

      // A visit that isn't bookable online is refused, even if asked for directly.
      const sick = (await db.query<{ id: string }>(`SELECT id FROM services WHERE location_id = $1 AND pack_service_id = 'sick_visit'`, [loc.id])).rows[0]!;
      expect((await widgetTimes(db, { locationId: loc.id, timezone: loc.timezone, session, patientId: dog.id, serviceId: sick.id, now })).status).toBe("blocked");
      await expect(setServiceBookableOnline(db, { locationId: loc.id, actor: staff }, sick.id, true)).rejects.toThrow(ValidationError);

      // Book the first free time for a routine visit, then not again.
      let booked = false;
      for (const s of services) {
        const t = await widgetTimes(db, { locationId: loc.id, timezone: loc.timezone, session, patientId: dog.id, serviceId: s.id, now });
        if (t.status !== "ok" || !t.days[0]) continue;
        const first = t.days[0].times[0]!;
        const r = await widgetBook(db, { locationId: loc.id, clinicName: clinic!.name, timezone: loc.timezone, session, patientId: dog.id, serviceId: s.id, start: first.start, providerId: first.providerId, now, sandbox: true });
        if (r.status !== "booked") continue;
        const a = (await db.query<{ booked_by: string }>(`SELECT booked_by FROM appointments WHERE id = $1`, [r.appointmentId])).rows[0]!;
        expect(a.booked_by).toBe("web");
        const again = await widgetBook(db, { locationId: loc.id, clinicName: clinic!.name, timezone: loc.timezone, session, patientId: dog.id, serviceId: s.id, start: first.start, providerId: first.providerId, now, sandbox: true });
        expect(again.status).toBe("already_booked");
        booked = true;
        break;
      }
      expect(booked).toBe(true);

      // Someone else's pet can't be booked with this session.
      const other = (await db.query<{ id: string }>(`SELECT id FROM patients WHERE location_id = $1 AND client_id <> $2 AND status = 'active' LIMIT 1`, [loc.id, c.id])).rows[0]!;
      await expect(widgetTimes(db, { locationId: loc.id, timezone: loc.timezone, session, patientId: other.id, serviceId: services[0]!.id, now })).rejects.toThrow(ValidationError);

      // The widget's chat is a front desk conversation on the "web" channel.
      const chat = await startFrontDesk(asPool(db) as never, { locationId: loc.id, channel: "web", callerNumber: c.mobile, sandbox: true }, now);
      expect(chat.replies.length).toBeGreaterThan(0);
      expect((await db.query<{ channel: string }>(`SELECT channel FROM calls WHERE id = $1`, [chat.callId])).rows[0]!.channel).toBe("web");
    } finally {
      await db.query("ROLLBACK").catch(() => {});
      db.release();
      await pool.end();
    }
  }, 180_000);

  it("adds a new client and their pet, who can book only a first exam", async () => {
    const pool = new Pool({ connectionString: url, max: 1 });
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const loc = (await db.query<{ id: string; timezone: string }>(`SELECT id, timezone FROM locations ORDER BY name LIMIT 1`)).rows[0]!;
      await saveWidgetSettings(db, { locationId: loc.id, actor: staff }, { enabled: true, origins: [] });
      const now = Date.now();
      const mobile = "+15125550199";
      await db.query(`DELETE FROM clients WHERE location_id = $1 AND mobile = $2`, [loc.id, mobile]).catch(() => {});

      const sent = await startWidgetCode(db, { locationId: loc.id, mobile: "(512) 555-0199", now });
      if (sent.status !== "sent") throw new Error(sent.status);
      expect(sent.clientName).toBeNull();
      // Too late: the code has expired.
      expect((await verifyWidgetCode(db, { locationId: loc.id, mobile, code: sent.code, now: now + 11 * 60_000 })).status).toBe("expired");
      const again = await startWidgetCode(db, { locationId: loc.id, mobile, now: now + 60_000 });
      if (again.status !== "sent") throw new Error(again.status);
      const ok = await verifyWidgetCode(db, { locationId: loc.id, mobile, code: again.code, now: now + 60_000 });
      if (ok.status !== "ok") throw new Error(ok.status);
      expect(ok.session.clientId).toBeNull();

      const { clientId, patientId } = await widgetRegister(db, {
        locationId: loc.id,
        timezone: loc.timezone,
        session: ok.session,
        now,
        form: { firstName: "Sam", lastName: "Rivera", email: "", smsConsent: true, petName: "Mochi", species: "cat", ageBand: "6m_2y", sex: "female" },
      });
      const row = (await db.query<{ source: string; sms_consent: boolean; provisional: boolean }>(
        `SELECT c.source, c.sms_consent, p.provisional FROM clients c JOIN patients p ON p.client_id = c.id WHERE c.id = $1 AND p.id = $2`,
        [clientId, patientId],
      )).rows[0]!;
      expect(row).toEqual({ source: "web", sms_consent: true, provisional: true });
      // Registering twice is refused.
      await expect(
        widgetRegister(db, { locationId: loc.id, timezone: loc.timezone, session: ok.session, now, form: { firstName: "Sam", lastName: "Rivera", smsConsent: true, petName: "Mochi", species: "cat", ageBand: "6m_2y", sex: null } }),
      ).rejects.toThrow(ValidationError);

      const services = await widgetServices(db, { locationId: loc.id, species: "cat", newPatient: true });
      expect(services.map((s) => s.packServiceId)).toEqual(["wellness_exam_new"]);
      const t = await widgetTimes(db, { locationId: loc.id, timezone: loc.timezone, session: ok.session, patientId, serviceId: services[0]!.id, now });
      expect(t.status).toBe("ok");
      if (t.status !== "ok") return;
      const first = t.days[0]!.times[0]!;
      const r = await widgetBook(db, { locationId: loc.id, clinicName: "Clinic", timezone: loc.timezone, session: ok.session, patientId, serviceId: services[0]!.id, start: first.start, providerId: first.providerId, now, sandbox: true });
      expect(r.status).toBe("booked");
      if (r.status === "booked") expect(r.confirmation).toBe("sms");
    } catch (error) {
      if (error instanceof RuleViolationError) throw new Error(`rule: ${error.message}`);
      throw error;
    } finally {
      await db.query("ROLLBACK").catch(() => {});
      db.release();
      await pool.end();
    }
  }, 180_000);
});
