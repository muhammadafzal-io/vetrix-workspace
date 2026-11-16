// Online booking links on the sample clinic, inside a transaction that is rolled back.
import { describe, expect, it } from "vitest";
import { Pool } from "@neondatabase/serverless";
import { bookFromLink, bookingLinkTimes, loadBookingLink } from "./booking-links";
import { runReminders } from "./retention";

const url = process.env.CLINIC_DATABASE_URL_DEV;
const actor = { type: "staff" as const, id: null };
const base = "https://app.test/b/sample";
const values = { clinicName: "Main Veterinary Clinic", aiName: "Riley", clinicPhone: "(555) 010-1000", bookingLink: "reply to this text", bookingLinkBase: base };

describe.skipIf(!url)("online booking links on the clinic database", () => {
  it("reminders carry personal links that book the right visit once, with a confirmation", async () => {
    const pool = new Pool({ connectionString: url, max: 1 });
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const loc = (await db.query<{ id: string }>(`SELECT id FROM locations ORDER BY name LIMIT 1`)).rows[0]!.id;
      const run = await runReminders(db, { locationId: loc, asOf: "2026-11-03", sandbox: true, quietHours: false, values, actor });
      expect(run.summary.messages).toBeGreaterThan(0);

      const links = (await db.query<{ token: string; body: string; items: number }>(
        `SELECT bl.token, m.body, (SELECT count(*)::int FROM booking_link_items i WHERE i.link_id = bl.id) AS items
         FROM booking_links bl JOIN messages m ON m.id = bl.message_id WHERE bl.location_id = $1`,
        [loc],
      )).rows;
      expect(links.length).toBeGreaterThan(0);
      // Every link is in its own message, and every message that offers a link has one.
      for (const l of links) expect(l.body).toContain(`${base}/${l.token}`);
      const withLink = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM messages WHERE location_id = $1 AND body LIKE $2`, [loc, `%${base}/%`])).rows[0]!.n;
      expect(withLink).toBe(links.length);
      expect(new Set(links.map((l) => l.token)).size).toBe(links.length);
      // Household messages cover several pets.
      expect(links.some((l) => l.items > 1)).toBe(true);

      // Find a pet whose visit can be booked online.
      const now = Date.now();
      let picked: { token: string; patientId: string; start: number; providerId: string } | null = null;
      for (const l of links) {
        const view = await loadBookingLink(db, l.token, now);
        for (const pet of view!.pets.filter((p) => !p.booked && !p.unavailable)) {
          const t = await bookingLinkTimes(db, { token: l.token, patientId: pet.patientId, now });
          if (t.status === "ok" && t.days[0]) {
            const first = t.days[0].times[0]!;
            picked = { token: l.token, patientId: pet.patientId, start: first.start, providerId: first.providerId };
            break;
          }
        }
        if (picked) break;
      }
      expect(picked).not.toBeNull();
      const p = picked!;
      expect(p.start).toBeGreaterThanOrEqual(now + 120 * 60_000);

      const booked = await bookFromLink(db, { ...p, now, sandbox: true });
      expect(booked.status).toBe("booked");
      if (booked.status !== "booked") return;
      const appt = (await db.query<{ booked_by: string; status: string }>(`SELECT booked_by, status FROM appointments WHERE id = $1`, [booked.appointmentId])).rows[0]!;
      expect(appt).toEqual({ booked_by: "web", status: "requested" });
      if (booked.confirmation) {
        const msg = (await db.query<{ body: string; status: string }>(`SELECT body, status FROM messages WHERE appointment_id = $1 AND template_key = 'appointment_confirmation'`, [booked.appointmentId])).rows[0]!;
        expect(msg.status).toBe("simulated");
        expect(msg.body).toContain(booked.petName);
      }
      // The page now shows it booked, and the same link cannot book it twice.
      expect((await loadBookingLink(db, p.token, now))!.pets.find((x) => x.patientId === p.patientId)!.booked).not.toBeNull();
      expect((await bookFromLink(db, { ...p, now, sandbox: true })).status).toBe("already_booked");

      // Expired links stop working; unknown tokens show nothing.
      await db.query(`UPDATE booking_links SET expires_at = now() - interval '1 day' WHERE token = $1`, [p.token]);
      expect((await loadBookingLink(db, p.token, now))!.expired).toBe(true);
      expect((await bookingLinkTimes(db, { token: p.token, patientId: p.patientId, now })).status).toBe("expired");
      expect(await loadBookingLink(db, "AAAAAAAAAAAAAAAAAAAA", now)).toBeNull();
    } finally {
      await db.query("ROLLBACK");
      db.release();
      await pool.end();
    }
  }, 300_000);
});
