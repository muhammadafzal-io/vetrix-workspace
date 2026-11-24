// Overdue vaccine reminders (Feature 3) on the sample clinic, inside a
// transaction that is always rolled back: the clinic's own schedule, pause,
// closing a reminder once the vaccine is given, the numbers, send retries and
// delivery reports. Skipped without the development database URL (CI).
import { describe, expect, it } from "vitest";
import { Pool } from "@neondatabase/serverless";
import { RuleViolationError, ValidationError } from "@vetrix/domain";
import { runDueJobs } from "./jobs";
import { queuedMessages, setDeliveryStatus, setMessageResult } from "./messages";
import { closeVaccinatedReminders, previewReminders, retentionStats, runReminders } from "./retention";
import { loadSettings, saveReminderSchedule, setRemindersPaused } from "./settings";
import type { SqlClient } from "./sql-client";

const url = process.env.CLINIC_DATABASE_URL_DEV;
const actor = { type: "staff" as const, id: null };
const values = { clinicName: "Main Veterinary Clinic", aiName: "Riley", clinicPhone: "(555) 010-1000", bookingLink: "reply to this text" };
const schedule = [
  { offset_days: -30, channels: ["email", "sms"], template: "vaccine_due_30" },
  { offset_days: -7, channels: ["sms"], template: "vaccine_due_7" },
  { offset_days: 3, channels: ["sms"], template: "vaccine_overdue_3" },
  { offset_days: 7, channels: ["sms", "email"], template: "vaccine_overdue_7" },
];

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

/** A dog whose owner may be texted, with only one vaccine on record: Rabies due on `dueAt`. */
async function dogWithRabiesDue(db: SqlClient, loc: string, dueAt: string) {
  const pet = (
    await db.query<{ id: string; client_id: string }>(
      `SELECT p.id, p.client_id FROM patients p JOIN clients c ON c.id = p.client_id
       WHERE p.location_id = $1 AND p.species = 'dog' AND p.status = 'active' AND c.sms_consent
         AND NOT EXISTS (SELECT 1 FROM client_flags f WHERE f.client_id = c.id)
         AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = p.id AND a.status IN ('requested', 'confirmed'))
       ORDER BY p.name LIMIT 1`,
      [loc],
    )
  ).rows[0]!;
  await db.query(`DELETE FROM vaccine_records WHERE patient_id = $1`, [pet.id]);
  await db.query(
    `INSERT INTO vaccine_records (patient_id, vaccine_id, administered_at, due_at, interval_months, administered_by)
     VALUES ($1, 'rabies_dog', $2::date - interval '12 months', $2, 12, 'this_clinic')`,
    [pet.id, dueAt],
  );
  return pet;
}

describe.skipIf(!url)("overdue vaccine reminders on the clinic database", () => {
  it("runs the clinic's schedule: the +3 overdue text, then nothing twice", () =>
    withRollback(async (db, loc) => {
      await expect(saveReminderSchedule(db, { locationId: loc, actor }, "vaccine_due", [...schedule, { offset_days: 14, channels: ["sms"], template: "vaccine_overdue_7" }])).rejects.toBeInstanceOf(ValidationError);
      await saveReminderSchedule(db, { locationId: loc, actor }, "vaccine_due", schedule);
      const settings = await loadSettings(db, loc);
      expect(settings.reminderSchedules.find((s) => s.ruleId === "vaccine_due")).toMatchObject({ custom: true, touches: schedule.map((t) => expect.objectContaining({ offset_days: t.offset_days })) });

      const pet = await dogWithRabiesDue(db, loc, "2027-03-07");
      const preview = await previewReminders(db, loc, "2027-03-10");
      const row = preview.rows.find((r) => r.patientId === pet.id && r.ruleId === "vaccine_due")!;
      expect(row.dueIn).toBe(-3);
      expect(row.nextTouch).toMatchObject({ offsetDays: 3, channels: ["sms"], template: "vaccine_overdue_3" });

      await runReminders(db, { locationId: loc, asOf: "2027-03-10", sandbox: true, quietHours: false, values, actor });
      const sent = await db.query<{ template_key: string; body: string }>(`SELECT template_key, body FROM messages WHERE patient_id = $1 AND template_key LIKE 'vaccine_%' AND created_at >= now()`, [pet.id]);
      expect(sent.rows).toEqual([expect.objectContaining({ template_key: "vaccine_overdue_3" })]);
      expect(sent.rows[0]!.body).toContain("is now overdue");

      // Day 7: the +7 text and email; the +3 is not sent again.
      await runReminders(db, { locationId: loc, asOf: "2027-03-14", sandbox: true, quietHours: false, values, actor });
      const later = await db.query<{ template_key: string; channel: string }>(`SELECT template_key, channel FROM messages WHERE patient_id = $1 AND template_key LIKE 'vaccine_%' AND created_at >= now() ORDER BY template_key, channel`, [pet.id]);
      expect(later.rows.map((r) => `${r.template_key}:${r.channel}`)).toEqual(["vaccine_overdue_3:sms", "vaccine_overdue_7:email", "vaccine_overdue_7:sms"]);

      // Back to the standard schedule: the pack's touches again.
      await saveReminderSchedule(db, { locationId: loc, actor }, "vaccine_due", null);
      expect((await loadSettings(db, loc)).reminderSchedules[0]!.custom).toBe(false);
    }), 300_000);

  it("pauses: a run is refused and the daily job skips reminders without claiming the day", () =>
    withRollback(async (db, loc) => {
      await setRemindersPaused(db, { locationId: loc, actor }, true);
      expect((await loadSettings(db, loc)).remindersPaused).toBe(true);
      await expect(runReminders(db, { locationId: loc, asOf: "2027-03-10", sandbox: true, quietHours: false, values, actor })).rejects.toBeInstanceOf(RuleViolationError);
      // Noon in the clinic's time zone, well after the 06:00 run time.
      const tz = (await db.query<{ timezone: string }>(`SELECT timezone FROM locations WHERE id = $1`, [loc])).rows[0]!.timezone;
      const noon = Date.parse((await db.query<{ t: string }>(`SELECT (date_trunc('day', now() AT TIME ZONE $1) + interval '12 hours') AT TIME ZONE $1 AS t`, [tz])).rows[0]!.t);
      await db.query(`DELETE FROM job_runs WHERE location_id = $1 AND job = 'reminders'`, [loc]);
      const paused = await runDueJobs(db, { locationId: loc, now: noon, sandbox: true, values });
      expect(paused.ran).not.toContain("reminders");
      await setRemindersPaused(db, { locationId: loc, actor }, false);
      const resumed = await runDueJobs(db, { locationId: loc, now: noon, sandbox: true, values });
      expect(resumed.ran).toContain("reminders");
    }), 300_000);

  it("closes the reminder once the vaccine is given again, and counts it as vaccinated", () =>
    withRollback(async (db, loc) => {
      await saveReminderSchedule(db, { locationId: loc, actor }, "vaccine_due", schedule);
      const pet = await dogWithRabiesDue(db, loc, "2027-03-07");
      await runReminders(db, { locationId: loc, asOf: "2027-03-10", sandbox: true, quietHours: false, values, actor });
      const today = (await db.query<{ d: string }>(`SELECT to_char(now(), 'YYYY-MM-DD') AS d`)).rows[0]!.d;
      const before = await retentionStats(db, loc, today);

      await db.query(`INSERT INTO vaccine_records (patient_id, vaccine_id, administered_at, due_at, interval_months, administered_by) VALUES ($1, 'rabies_dog', '2027-03-12', '2030-03-12', 36, 'this_clinic')`, [pet.id]);
      expect(await closeVaccinatedReminders(db, loc, pet.id)).toBe(1);
      const r = await db.query<{ status: string; stop_reason: string }>(
        `SELECT r.status, r.stop_reason FROM reminders r JOIN reminder_rules rr ON rr.id = r.rule_id WHERE r.patient_id = $1 AND rr.pack_rule_id = 'vaccine_due' AND r.due_at = '2027-03-07'`,
        [pet.id],
      );
      expect(r.rows).toEqual([{ status: "completed", stop_reason: "vaccinated" }]);
      const after = await retentionStats(db, loc, today);
      expect(after.vaccinated).toBe(before.vaccinated + 1);
      expect(after.reminded).toBe(before.reminded);
      expect(after.conversion).toBeGreaterThan(0);
      // Nothing more goes out for the old due date.
      const preview = await previewReminders(db, loc, "2027-03-14");
      expect(preview.rows.filter((x) => x.patientId === pet.id && x.ruleId === "vaccine_due" && x.dueAt === "2027-03-07")).toEqual([]);
    }), 300_000);

  it("retries a send that may pass, gives up after four tries, and records delivery reports", () =>
    withRollback(async (db, loc) => {
      const client = (await db.query<{ id: string }>(`SELECT id FROM clients WHERE location_id = $1 LIMIT 1`, [loc])).rows[0]!.id;
      const add = async () =>
        (await db.query<{ id: string }>(`INSERT INTO messages (location_id, client_id, channel, template_key, body, status) VALUES ($1, $2, 'sms', 'vaccine_overdue_3', 'x', 'queued') RETURNING id`, [loc, client])).rows[0]!.id;
      const now = Date.now();

      const flaky = await add();
      expect(await setMessageResult(db, { locationId: loc, messageId: flaky, ok: false, providerMessageId: null, error: "503", retry: { httpStatus: 503, now } })).toEqual({ status: "queued", attempts: 1 });
      expect((await queuedMessages(db, loc, 500)).some((m) => m.messageId === flaky)).toBe(false); // waits 5 minutes
      for (const n of [2, 3]) expect((await setMessageResult(db, { locationId: loc, messageId: flaky, ok: false, providerMessageId: null, retry: { httpStatus: null, now } })).status).toBe("queued");
      expect(await setMessageResult(db, { locationId: loc, messageId: flaky, ok: false, providerMessageId: null, retry: { httpStatus: 500, now } })).toEqual({ status: "failed", attempts: 4 });

      const refused = await add();
      expect((await setMessageResult(db, { locationId: loc, messageId: refused, ok: false, providerMessageId: null, retry: { httpStatus: 400, now } })).status).toBe("failed");

      // A queued retry ready to go is picked up, except a text in quiet hours.
      const ready = await add();
      await setMessageResult(db, { locationId: loc, messageId: ready, ok: false, providerMessageId: null, retry: { httpStatus: 503, now: now - 3_600_000 } });
      expect((await queuedMessages(db, loc, 500)).some((m) => m.messageId === ready)).toBe(true);
      expect((await queuedMessages(db, loc, 500, { quietHours: true })).some((m) => m.messageId === ready)).toBe(false);

      const ok = await add();
      const sid = `SM${"a".repeat(32)}`;
      await setMessageResult(db, { locationId: loc, messageId: ok, ok: true, providerMessageId: sid });
      expect(await setDeliveryStatus(db, { providerMessageId: sid, status: "delivered" })).toBe(true);
      const row = await db.query<{ status: string; attempts: number; delivered: boolean }>(`SELECT status, attempts, delivered_at IS NOT NULL AS delivered FROM messages WHERE id = $1`, [ok]);
      expect(row.rows[0]).toEqual({ status: "delivered", attempts: 1, delivered: true });
      // A late "failed" report never undoes a delivery.
      expect(await setDeliveryStatus(db, { providerMessageId: sid, status: "failed" })).toBe(false);
    }), 300_000);
});
