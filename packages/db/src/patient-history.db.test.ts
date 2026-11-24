// Patient history against the sample clinic, inside a transaction that is
// always rolled back. Skipped without the development database URL (CI).
import { describe, expect, it } from "vitest";
import { Pool } from "@neondatabase/serverless";
import { HISTORY_FILTERS, NotFoundError, RuleViolationError, ValidationError } from "@vetrix/domain";
import { completeVisit, patientHealthSummary, patientTimeline, setVisitStatus, vaccineChoicesFor, weightHistory } from "./patient-history";
import type { SqlClient } from "./sql-client";

const url = process.env.CLINIC_DATABASE_URL_DEV;
const actor = { type: "staff" as const, id: null };
const now = new Date();

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

/** A dog and a confirmed visit for it that started `hoursAgo` hours ago (negative: in the future). */
async function visit(db: SqlClient, loc: string, hoursAgo = 1) {
  const pet = (
    await db.query<{ id: string; client_id: string }>(
      `SELECT id, client_id FROM patients WHERE location_id = $1 AND species = 'dog' AND status = 'active' ORDER BY name LIMIT 1`,
      [loc],
    )
  ).rows[0]!;
  const service = (await db.query<{ id: string }>(`SELECT id FROM services WHERE location_id = $1 AND pack_service_id = 'wellness_exam'`, [loc])).rows[0]!.id;
  const start = new Date(now.getTime() - hoursAgo * 3_600_000);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO appointments (location_id, patient_id, client_id, service_id, start_at, end_at, status, booked_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', 'staff') RETURNING id`,
    [loc, pet.id, pet.client_id, service, start, new Date(start.getTime() + 30 * 60_000)],
  );
  return { appointmentId: rows[0]!.id, patientId: pet.id };
}

describe.skipIf(!url)("patient history on the clinic database", () => {
  it("completes a visit: status, weight, vaccines with due dates, audit, and only once", () =>
    withRollback(async (db, loc) => {
      const { appointmentId, patientId } = await visit(db, loc);
      const choices = await vaccineChoicesFor(db, "dog");
      expect(choices.length).toBeGreaterThan(0);
      const vaccine = choices[0]!;

      const done = await completeVisit(db, {
        locationId: loc, appointmentId, actor, now, canRecordVaccines: true,
        outcome: { weightKg: "21.4", vaccineIds: [vaccine.id] },
      });
      expect(done.weightKg).toBe(21.4);
      expect(done.vaccinesRecorded).toHaveLength(1);

      const a = await db.query<{ status: string }>(`SELECT status FROM appointments WHERE id = $1`, [appointmentId]);
      expect(a.rows[0]!.status).toBe("completed");
      const hist = await db.query(`SELECT 1 FROM appointment_status_history WHERE appointment_id = $1 AND to_status = 'completed'`, [appointmentId]);
      expect(hist.rows).toHaveLength(1);
      const p = await db.query<{ weight_kg: string }>(`SELECT weight_kg::text FROM patients WHERE id = $1`, [patientId]);
      expect(Number(p.rows[0]!.weight_kg)).toBe(21.4);
      const v = await db.query<{ due_at: string }>(
        `SELECT to_char(due_at, 'YYYY-MM-DD') AS due_at FROM vaccine_records WHERE patient_id = $1 AND vaccine_id = $2 ORDER BY administered_at DESC LIMIT 1`,
        [patientId, vaccine.id],
      );
      expect(v.rows[0]!.due_at).toBe(done.vaccinesRecorded[0]!.dueAt);
      const audit = await db.query(`SELECT 1 FROM audit_logs WHERE entity_id = $1 AND action = 'appointment.completed'`, [appointmentId]);
      expect(audit.rows).toHaveLength(1);

      // A second attempt is refused and adds nothing.
      await expect(
        completeVisit(db, { locationId: loc, appointmentId, actor, now, canRecordVaccines: true, outcome: { weightKg: "30" } }),
      ).rejects.toBeInstanceOf(RuleViolationError);
      const weights = await db.query(`SELECT 1 FROM patient_weights WHERE appointment_id = $1`, [appointmentId]);
      expect(weights.rows).toHaveLength(1);
    }), 120_000);

  it("ignores vaccines from someone who may not record them, and refuses a cat vaccine for a dog", () =>
    withRollback(async (db, loc) => {
      const { appointmentId, patientId } = await visit(db, loc);
      const dogVaccine = (await vaccineChoicesFor(db, "dog"))[0]!.id;
      const before = await db.query(`SELECT 1 FROM vaccine_records WHERE patient_id = $1`, [patientId]);
      await completeVisit(db, { locationId: loc, appointmentId, actor, now, canRecordVaccines: false, outcome: { vaccineIds: [dogVaccine] } });
      const after = await db.query(`SELECT 1 FROM vaccine_records WHERE patient_id = $1`, [patientId]);
      expect(after.rows.length).toBe(before.rows.length);

      const second = await visit(db, loc);
      const catOnly = (await db.query<{ id: string }>(`SELECT id FROM vaccine_types WHERE NOT ('dog' = ANY (string_to_array(species, ','))) LIMIT 1`)).rows[0];
      if (catOnly) {
        await expect(
          completeVisit(db, { locationId: loc, appointmentId: second.appointmentId, actor, now, canRecordVaccines: true, outcome: { vaccineIds: [catOnly.id] } }),
        ).rejects.toBeInstanceOf(ValidationError);
      }
    }), 120_000);

  it("checks in early, but refuses a no-show or completion before the visit starts", () =>
    withRollback(async (db, loc) => {
      const { appointmentId } = await visit(db, loc, -2);
      await expect(setVisitStatus(db, { locationId: loc, appointmentId, to: "no_show", actor, now })).rejects.toBeInstanceOf(RuleViolationError);
      await setVisitStatus(db, { locationId: loc, appointmentId, to: "checked_in", actor, now });
      await expect(
        completeVisit(db, { locationId: loc, appointmentId, actor, now, canRecordVaccines: false, outcome: {} }),
      ).rejects.toBeInstanceOf(RuleViolationError);
    }), 120_000);

  it("marks a no-show with its history and audit entry", () =>
    withRollback(async (db, loc) => {
      const { appointmentId } = await visit(db, loc, 2);
      await setVisitStatus(db, { locationId: loc, appointmentId, to: "no_show", actor, now });
      const a = await db.query<{ status: string }>(`SELECT status FROM appointments WHERE id = $1`, [appointmentId]);
      expect(a.rows[0]!.status).toBe("no_show");
      const audit = await db.query(`SELECT 1 FROM audit_logs WHERE entity_id = $1 AND action = 'appointment.no_show'`, [appointmentId]);
      expect(audit.rows).toHaveLength(1);
    }), 120_000);

  it("builds the timeline newest first, pages without gaps, and respects the kinds asked for", () =>
    withRollback(async (db, loc) => {
      const { appointmentId, patientId } = await visit(db, loc);
      await completeVisit(db, { locationId: loc, appointmentId, actor, now, canRecordVaccines: false, outcome: { weightKg: "20" } });

      const all = await patientTimeline(db, loc, patientId, { kinds: ["visit", "vaccine", "prevention", "weight", "call", "message", "task"], limit: 100 });
      expect(all.entries.length).toBeGreaterThan(1);
      const times = all.entries.map((e) => e.at.getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);
      expect(all.entries.some((e) => e.kind === "visit" && e.id === appointmentId && e.status === "completed" && e.source === "clinic")).toBe(true);

      // Two small pages give the same rows as one big one.
      const first = await patientTimeline(db, loc, patientId, { kinds: ["visit", "vaccine", "weight"], limit: 2 });
      const second = await patientTimeline(db, loc, patientId, { kinds: ["visit", "vaccine", "weight"], limit: 2, before: first.next });
      const big = await patientTimeline(db, loc, patientId, { kinds: ["visit", "vaccine", "weight"], limit: 4 });
      expect([...first.entries, ...second.entries].map((e) => e.id)).toEqual(big.entries.slice(0, first.entries.length + second.entries.length).map((e) => e.id));

      // Every filter chip runs, including ones whose queries do not use the location.
      for (const f of HISTORY_FILTERS) {
        for (const k of f.kinds) await patientTimeline(db, loc, patientId, { kinds: [k], limit: 5 });
        await patientTimeline(db, loc, patientId, { kinds: [...f.kinds], limit: 5, before: first.next });
      }
      const health = await patientTimeline(db, loc, patientId, { kinds: ["vaccine", "prevention", "weight"], limit: 100 });
      expect(health.entries.some((e) => e.kind === "weight" && e.title === "20 kg")).toBe(true);

      const visitsOnly = await patientTimeline(db, loc, patientId, { kinds: ["visit"], limit: 100 });
      expect(visitsOnly.entries.every((e) => e.kind === "visit")).toBe(true);
      expect((await patientTimeline(db, loc, patientId, { kinds: [] })).entries).toEqual([]);

      const weights = await weightHistory(db, loc, patientId);
      expect(weights[weights.length - 1]!.kg).toBe(20);
      const summary = await patientHealthSummary(db, loc, patientId, now.toISOString().slice(0, 10));
      expect(summary.visits.completed).toBeGreaterThanOrEqual(1);
      expect(summary.latestWeight?.kg).toBe(20);
    }), 120_000);

  it("never shows another location's pet or visit", () =>
    withRollback(async (db, loc) => {
      const { appointmentId, patientId } = await visit(db, loc);
      const other = "00000000-0000-0000-0000-000000000000";
      await expect(patientTimeline(db, other, patientId, { kinds: ["visit"] })).rejects.toBeInstanceOf(NotFoundError);
      await expect(patientHealthSummary(db, other, patientId, "2026-11-23")).rejects.toBeInstanceOf(NotFoundError);
      await expect(setVisitStatus(db, { locationId: other, appointmentId, to: "checked_in", actor, now })).rejects.toBeInstanceOf(NotFoundError);
    }), 120_000);
});
