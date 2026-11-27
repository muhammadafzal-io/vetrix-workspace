// Visit records against the sample clinic, inside a transaction that is
// always rolled back. Skipped without the development database URL (CI).
import { describe, expect, it } from "vitest";
import { Pool } from "@neondatabase/serverless";
import { RuleViolationError, ValidationError } from "@vetrix/domain";
import {
  addPrescription,
  addVisitEntry,
  checkVisitPhoto,
  editVisitEntry,
  loadVisitRecord,
  recordVisitPhoto,
  visitPhotoFile,
  visitRecordCounts,
  voidVisitRecord,
} from "./visit-records";
import type { SqlClient } from "./sql-client";

const url = process.env.CLINIC_DATABASE_URL_DEV;
const now = new Date();
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);

async function withRollback(fn: (db: SqlClient, loc: string) => Promise<void>) {
  const pool = new Pool({ connectionString: url, max: 1 });
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const loc = (await db.query<{ id: string }>(`SELECT id FROM locations ORDER BY name LIMIT 1`)).rows[0]!.id;
    await fn(db, loc);
  } finally {
    await db.query("ROLLBACK");
    db.release();
    await pool.end();
  }
}

/** A staff member (as the actor) and a visit for a dog in the given status. */
async function setup(db: SqlClient, loc: string, status = "checked_in") {
  const staff = (
    await db.query<{ id: string }>(
      `INSERT INTO staff_users (platform_user_ref, display_name) VALUES (gen_random_uuid(), 'Records Test') RETURNING id`,
    )
  ).rows[0]!.id;
  const pet = (
    await db.query<{ id: string; client_id: string }>(
      `SELECT id, client_id FROM patients WHERE location_id = $1 AND species = 'dog' AND status = 'active' ORDER BY name LIMIT 1`,
      [loc],
    )
  ).rows[0]!;
  const service = (await db.query<{ id: string }>(`SELECT id FROM services WHERE location_id = $1 AND pack_service_id = 'wellness_exam'`, [loc])).rows[0]!.id;
  const start = new Date(now.getTime() - 3_600_000);
  const appointmentId = (
    await db.query<{ id: string }>(
      `INSERT INTO appointments (location_id, patient_id, client_id, service_id, start_at, end_at, status, booked_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'staff') RETURNING id`,
      [loc, pet.id, pet.client_id, service, start, new Date(start.getTime() + 30 * 60_000), status],
    )
  ).rows[0]!.id;
  const doctor = (await db.query<{ id: string }>(`SELECT id FROM providers WHERE location_id = $1 AND role = 'dvm' ORDER BY display_name LIMIT 1`, [loc])).rows[0]!.id;
  const nonDoctor = (await db.query<{ id: string }>(`SELECT id FROM providers WHERE location_id = $1 AND role <> 'dvm' LIMIT 1`, [loc])).rows[0]?.id;
  return { actor: { type: "staff" as const, id: staff }, appointmentId, patientId: pet.id, doctor, nonDoctor };
}

async function audits(db: SqlClient, entityId: string) {
  return (await db.query<{ action: string; changes: Record<string, unknown> }>(`SELECT action, changes FROM audit_logs WHERE entity_id = $1 ORDER BY occurred_at`, [entityId])).rows;
}

describe.skipIf(!url)("visit records on the clinic database", () => {
  it("adds, edits and removes notes; the old text stays in the audit log and removed rows stay in the table", () =>
    withRollback(async (db, loc) => {
      const { actor, appointmentId } = await setup(db, loc);
      const { id } = await addVisitEntry(db, { locationId: loc, appointmentId, actor, entry: { kind: "note", body: "Limping on left fore" } });
      await editVisitEntry(db, { locationId: loc, entryId: id, body: "Limping on left fore, swelling at the paw", actor, now });

      let record = await loadVisitRecord(db, loc, appointmentId);
      expect(record.entries).toHaveLength(1);
      expect(record.entries[0]!.body).toBe("Limping on left fore, swelling at the paw");
      expect(record.entries[0]!.authorName).toBe("Records Test");

      const log = await audits(db, id);
      expect(log.map((a) => a.action)).toEqual(["visit_note.added", "visit_note.edited"]);
      expect((log[1]!.changes.body as string[])[0]).toBe("Limping on left fore");

      // Another person cannot edit it.
      const other = { type: "staff" as const, id: (await setup(db, loc)).actor.id };
      await expect(editVisitEntry(db, { locationId: loc, entryId: id, body: "changed", actor: other, now })).rejects.toThrow(RuleViolationError);

      await expect(voidVisitRecord(db, { locationId: loc, table: "visit_entries", id, reason: "", actor })).rejects.toThrow(ValidationError);
      await voidVisitRecord(db, { locationId: loc, table: "visit_entries", id, reason: "Wrong pet", actor });
      expect((await loadVisitRecord(db, loc, appointmentId)).entries).toHaveLength(0);
      record = await loadVisitRecord(db, loc, appointmentId, { includeVoided: true });
      expect(record.entries[0]!.voidReason).toBe("Wrong pet");
      await expect(editVisitEntry(db, { locationId: loc, entryId: id, body: "again", actor, now })).rejects.toThrow(/removed/);
    }), 120_000);

  it("records in the audit log whether AI helped write an entry or prescription", () =>
    withRollback(async (db, loc) => {
      const { actor, appointmentId, doctor } = await setup(db, loc);
      const mine = await addVisitEntry(db, { locationId: loc, appointmentId, actor, entry: { kind: "note", body: "typed by hand" } });
      const helped = await addVisitEntry(db, { locationId: loc, appointmentId, actor, entry: { kind: "note", body: "tidied by AI" }, aiAssisted: true });
      const rx = await addPrescription(db, {
        locationId: loc, appointmentId, actor, aiAssisted: true,
        prescription: { drugName: "Apoquel", dose: "1/2 tablet", frequency: "Twice a day", prescribedBy: doctor },
      });
      expect((await audits(db, mine.id))[0]!.changes.ai_assisted).toBe(false);
      expect((await audits(db, helped.id))[0]!.changes.ai_assisted).toBe(true);
      expect((await audits(db, rx.id))[0]!.changes.ai_assisted).toBe(true);
    }), 120_000);

  it("keeps a follow-up date on a recommendation", () =>
    withRollback(async (db, loc) => {
      const { actor, appointmentId } = await setup(db, loc);
      const later = new Date(now.getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
      await addVisitEntry(db, { locationId: loc, appointmentId, actor, entry: { kind: "recommendation", body: "Recheck the paw", followUpOn: later } });
      const r = (await loadVisitRecord(db, loc, appointmentId)).entries[0]!;
      expect(r.kind).toBe("recommendation");
      expect(r.followUpOn).toBe(later);
    }), 120_000);

  it("refuses records on a visit that has not started or did not happen", () =>
    withRollback(async (db, loc) => {
      for (const status of ["confirmed", "cancelled", "no_show"]) {
        const { actor, appointmentId } = await setup(db, loc, status);
        await expect(addVisitEntry(db, { locationId: loc, appointmentId, actor, entry: { kind: "note", body: "x" } })).rejects.toThrow(RuleViolationError);
      }
    }), 120_000);

  it("refuses a visit from another location", () =>
    withRollback(async (db, loc) => {
      const { actor, appointmentId } = await setup(db, loc);
      await expect(addVisitEntry(db, { locationId: "00000000-0000-4000-8000-000000000000", appointmentId, actor, entry: { kind: "note", body: "x" } })).rejects.toThrow(/not found/);
    }), 120_000);

  it("records a prescription only from a doctor, turns on active prescriptions, and turns it off when the last one is removed", () =>
    withRollback(async (db, loc) => {
      const { actor, appointmentId, patientId, doctor, nonDoctor } = await setup(db, loc);
      await db.query(`UPDATE patients SET active_prescriptions = false WHERE id = $1`, [patientId]);
      const rx = { drugName: "Carprofen", strength: "75 mg", dose: "1 tablet", route: "oral", frequency: "Twice a day", durationDays: "7" };
      if (nonDoctor) {
        await expect(addPrescription(db, { locationId: loc, appointmentId, actor, prescription: { ...rx, prescribedBy: nonDoctor } })).rejects.toThrow(/doctor/);
      }
      const { id } = await addPrescription(db, { locationId: loc, appointmentId, actor, prescription: { ...rx, prescribedBy: doctor } });
      const active = async () => (await db.query<{ a: boolean }>(`SELECT active_prescriptions AS a FROM patients WHERE id = $1`, [patientId])).rows[0]!.a;
      expect(await active()).toBe(true);
      const record = await loadVisitRecord(db, loc, appointmentId);
      expect(record.prescriptions[0]).toMatchObject({ drugName: "Carprofen", durationDays: 7, refills: 0, prescribedBy: doctor });
      expect(record.doctors.some((d) => d.id === doctor)).toBe(true);

      await voidVisitRecord(db, { locationId: loc, table: "visit_prescriptions", id, reason: "Wrong dose", actor });
      expect(await active()).toBe(false);
      expect((await audits(db, id)).map((a) => a.action)).toEqual(["visit_prescription.added", "visit_prescription.removed"]);
    }), 120_000);

  it("saves photo details once per image, serves only live photos, and counts records for the History tab", () =>
    withRollback(async (db, loc) => {
      const { actor, appointmentId, patientId } = await setup(db, loc);
      const checked = await checkVisitPhoto(db, { locationId: loc, appointmentId, photo: { bytes: jpeg, bodyArea: "Left front paw" } });
      expect(checked.type).toBe("image/jpeg");
      expect(checked.bodyArea).toBe("Left front paw");

      const photoId = crypto.randomUUID();
      const base = {
        locationId: loc, appointmentId, patientId, contentType: "image/jpeg" as const, byteSize: 1234, width: 800, height: 600,
        sha256: "a".repeat(64), bodyArea: "Left front paw", caption: null, actor,
      };
      const first = await recordVisitPhoto(db, { ...base, photoId, storageKey: `k/${photoId}.jpg`, thumbKey: `k/${photoId}-thumb.jpg` });
      expect(first).toEqual({ id: photoId, duplicate: false });
      const again = crypto.randomUUID();
      const second = await recordVisitPhoto(db, { ...base, photoId: again, storageKey: `k/${again}.jpg`, thumbKey: `k/${again}-thumb.jpg` });
      expect(second).toEqual({ id: photoId, duplicate: true });

      expect(await visitPhotoFile(db, loc, photoId)).toMatchObject({ storageKey: `k/${photoId}.jpg`, patientId });
      await addVisitEntry(db, { locationId: loc, appointmentId, actor, entry: { kind: "note", body: "Swollen" } });
      expect((await visitRecordCounts(db, loc, [appointmentId])).get(appointmentId)).toEqual({ notes: 1, recommendations: 0, prescriptions: 0, photos: 1 });

      await voidVisitRecord(db, { locationId: loc, table: "visit_photos", id: photoId, reason: "Blurry", actor });
      expect(await visitPhotoFile(db, loc, photoId)).toBeNull();
    }), 120_000);

  it("protects records: the visit cannot be deleted while it has records", () =>
    withRollback(async (db, loc) => {
      const { actor, appointmentId } = await setup(db, loc);
      await addVisitEntry(db, { locationId: loc, appointmentId, actor, entry: { kind: "note", body: "x" } });
      await db.query("SAVEPOINT s");
      await expect(db.query(`DELETE FROM appointments WHERE id = $1`, [appointmentId])).rejects.toThrow(/foreign key/);
      await db.query("ROLLBACK TO SAVEPOINT s");
    }), 120_000);
});
