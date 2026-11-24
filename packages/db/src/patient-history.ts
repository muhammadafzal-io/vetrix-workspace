// Patient history against a clinic database: visit status changes from the
// schedule (check in, complete, no-show), what completing a visit records
// (weight, vaccines given), and the reads behind the pet's History tab.
// Every read checks the pet belongs to the location; every write is audited.
import {
  assertVisitChange,
  NotFoundError,
  validateVisitOutcome,
  vaccineDueDate,
  type HistoryKind,
  type HistorySource,
  type VisitOutcomeInput,
} from "@vetrix/domain";
import { writeAudit, type Actor } from "./clients";
import type { SqlClient } from "./sql-client";

interface VisitRow {
  id: string;
  status: string;
  patient_id: string;
  species: string;
  start_at: Date;
  visit_date: string;
}

async function lockVisit(db: SqlClient, locationId: string, appointmentId: string): Promise<VisitRow> {
  const { rows } = await db.query<VisitRow>(
    `SELECT a.id, a.status, a.patient_id, p.species, a.start_at,
            to_char(a.start_at AT TIME ZONE l.timezone, 'YYYY-MM-DD') AS visit_date
     FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN locations l ON l.id = a.location_id
     WHERE a.id = $1 AND a.location_id = $2
     FOR UPDATE OF a`,
    [appointmentId, locationId],
  );
  if (!rows[0]) throw new NotFoundError("Appointment", appointmentId);
  return rows[0];
}

async function recordStatus(db: SqlClient, visit: VisitRow, to: string, actor: Actor) {
  await db.query(`UPDATE appointments SET status = $2 WHERE id = $1`, [visit.id, to]);
  await db.query(
    `INSERT INTO appointment_status_history (appointment_id, from_status, to_status, actor_type) VALUES ($1, $2, $3, $4)`,
    [visit.id, visit.status, to, actor.type],
  );
}

/** Check-in or no-show. A no-show starts the pack's no-show follow-up on the next reminder run. Run in a transaction. */
export async function setVisitStatus(
  db: SqlClient,
  input: { locationId: string; appointmentId: string; to: "checked_in" | "no_show"; actor: Actor; now: Date },
): Promise<void> {
  const visit = await lockVisit(db, input.locationId, input.appointmentId);
  assertVisitChange({ from: visit.status, to: input.to, startAt: visit.start_at, now: input.now });
  await recordStatus(db, visit, input.to, input.actor);
  await writeAudit(db, {
    locationId: input.locationId,
    actor: input.actor,
    action: input.to === "no_show" ? "appointment.no_show" : "appointment.checked_in",
    entityType: "appointment",
    entityId: visit.id,
    changes: { status: [visit.status, input.to] },
  });
}

export interface VaccineChoice {
  id: string;
  name: string;
  core: boolean;
  default_interval_months: number;
}

/** Vaccines that apply to this pet's species, core ones first, for the "Vaccines given" list. */
export async function vaccineChoicesFor(db: SqlClient, species: string): Promise<VaccineChoice[]> {
  const { rows } = await db.query<VaccineChoice>(
    `SELECT id, name, core, default_interval_months FROM vaccine_types
     WHERE $1 = ANY (string_to_array(species, ','))
     ORDER BY core DESC, name`,
    [species],
  );
  return rows;
}

export interface CompletedVisit {
  weightKg: number | null;
  vaccinesRecorded: { name: string; dueAt: string }[];
}

/**
 * Marks a visit completed and records what staff entered: the weight (also
 * the pet's current weight) and each vaccine given, dated the visit day,
 * with its next due date. Recording vaccines moves the pet's reminders on.
 * Safe to retry: a second weight or the same vaccine on the same day is not
 * added twice. Run in a transaction.
 */
export async function completeVisit(
  db: SqlClient,
  input: { locationId: string; appointmentId: string; actor: Actor; now: Date; outcome: VisitOutcomeInput; canRecordVaccines: boolean },
): Promise<CompletedVisit> {
  const visit = await lockVisit(db, input.locationId, input.appointmentId);
  assertVisitChange({ from: visit.status, to: "completed", startAt: visit.start_at, now: input.now });
  const choices = await vaccineChoicesFor(db, visit.species);
  const outcome = validateVisitOutcome(
    { weightKg: input.outcome.weightKg, vaccineIds: input.canRecordVaccines ? input.outcome.vaccineIds : [] },
    new Set(choices.map((c) => c.id)),
  );
  const staffId = input.actor.type === "staff" ? input.actor.id : null;

  await recordStatus(db, visit, "completed", input.actor);

  if (outcome.weightKg !== null) {
    await db.query(
      `INSERT INTO patient_weights (patient_id, appointment_id, weight_kg, measured_on, source, recorded_by)
       VALUES ($1, $2, $3, $4, 'visit', $5)
       ON CONFLICT (appointment_id) WHERE appointment_id IS NOT NULL DO NOTHING`,
      [visit.patient_id, visit.id, outcome.weightKg, visit.visit_date, staffId],
    );
    await db.query(`UPDATE patients SET weight_kg = $2 WHERE id = $1`, [visit.patient_id, outcome.weightKg]);
  }

  const vaccinesRecorded: CompletedVisit["vaccinesRecorded"] = [];
  for (const id of outcome.vaccineIds) {
    const choice = choices.find((c) => c.id === id)!;
    const dueAt = vaccineDueDate(visit.visit_date, choice.default_interval_months);
    await db.query(
      `INSERT INTO vaccine_records (patient_id, vaccine_id, administered_at, due_at, interval_months, administered_by)
       VALUES ($1, $2, $3, $4, $5, 'this_clinic')
       ON CONFLICT (patient_id, vaccine_id, administered_at) DO NOTHING`,
      [visit.patient_id, id, visit.visit_date, dueAt, choice.default_interval_months],
    );
    vaccinesRecorded.push({ name: choice.name, dueAt });
  }

  await writeAudit(db, {
    locationId: input.locationId,
    actor: input.actor,
    action: "appointment.completed",
    entityType: "appointment",
    entityId: visit.id,
    changes: { status: [visit.status, "completed"], weight_kg: outcome.weightKg, vaccines: outcome.vaccineIds },
  });
  return { weightKg: outcome.weightKg, vaccinesRecorded };
}

// ---------- Reads for the History tab ----------

async function assertPet(db: SqlClient, locationId: string, patientId: string) {
  const { rows } = await db.query(`SELECT 1 FROM patients WHERE id = $1 AND location_id = $2`, [patientId, locationId]);
  if (!rows[0]) throw new NotFoundError("Patient", patientId);
}

export interface HealthSummary {
  visits: { completed: number; noShows: number; cancelled: number; upcoming: number };
  lastVisit: { date: string; service: string } | null;
  nextVisit: { date: string; service: string; appointmentId: string } | null;
  vaccines: { name: string; administeredAt: string; dueAt: string; state: "overdue" | "due_soon" | "current" }[];
  prevention: { product: string; supplyEndAt: string; state: "ended" | "ending_soon" | "current" }[];
  latestWeight: { kg: number; measuredOn: string } | null;
}

/** The health overview card. `today` is the clinic's date (YYYY-MM-DD). */
export async function patientHealthSummary(db: SqlClient, locationId: string, patientId: string, today: string): Promise<HealthSummary> {
  await assertPet(db, locationId, patientId);
  const [counts, last, next, vaccines, prevention, weight] = await Promise.all([
    db.query<{ completed: number; no_shows: number; cancelled: number; upcoming: number }>(
      `SELECT count(*) FILTER (WHERE status = 'completed')::int AS completed,
              count(*) FILTER (WHERE status = 'no_show')::int AS no_shows,
              count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
              count(*) FILTER (WHERE status IN ('requested', 'confirmed', 'checked_in', 'in_progress') AND start_at >= now() - interval '12 hours')::int AS upcoming
       FROM appointments WHERE patient_id = $1 AND location_id = $2`,
      [patientId, locationId],
    ),
    db.query<{ date: string; service: string }>(
      `SELECT to_char(a.start_at AT TIME ZONE l.timezone, 'YYYY-MM-DD') AS date, s.name AS service
       FROM appointments a JOIN services s ON s.id = a.service_id JOIN locations l ON l.id = a.location_id
       WHERE a.patient_id = $1 AND a.location_id = $2 AND a.status = 'completed'
       ORDER BY a.start_at DESC LIMIT 1`,
      [patientId, locationId],
    ),
    db.query<{ date: string; service: string; appointment_id: string }>(
      `SELECT to_char(a.start_at AT TIME ZONE l.timezone, 'YYYY-MM-DD') AS date, s.name AS service, a.id AS appointment_id
       FROM appointments a JOIN services s ON s.id = a.service_id JOIN locations l ON l.id = a.location_id
       WHERE a.patient_id = $1 AND a.location_id = $2 AND a.status IN ('requested', 'confirmed') AND a.start_at >= now()
       ORDER BY a.start_at LIMIT 1`,
      [patientId, locationId],
    ),
    // The latest record of each vaccine: that one sets the due date.
    db.query<{ name: string; administered_at: string; due_at: string }>(
      `SELECT DISTINCT ON (v.vaccine_id) vt.name, to_char(v.administered_at, 'YYYY-MM-DD') AS administered_at, to_char(v.due_at, 'YYYY-MM-DD') AS due_at
       FROM vaccine_records v JOIN vaccine_types vt ON vt.id = v.vaccine_id
       WHERE v.patient_id = $1
       ORDER BY v.vaccine_id, v.administered_at DESC`,
      [patientId],
    ),
    db.query<{ product: string; supply_end_at: string }>(
      `SELECT DISTINCT ON (product_type) product_name AS product, to_char(supply_end_at, 'YYYY-MM-DD') AS supply_end_at
       FROM prevention_products WHERE patient_id = $1
       ORDER BY product_type, supply_end_at DESC`,
      [patientId],
    ),
    db.query<{ kg: string; measured_on: string }>(
      `SELECT weight_kg::text AS kg, to_char(measured_on, 'YYYY-MM-DD') AS measured_on
       FROM patient_weights WHERE patient_id = $1 ORDER BY measured_on DESC, created_at DESC LIMIT 1`,
      [patientId],
    ),
  ]);
  const soon = addDays(today, 30);
  const c = counts.rows[0]!;
  return {
    visits: { completed: c.completed, noShows: c.no_shows, cancelled: c.cancelled, upcoming: c.upcoming },
    lastVisit: last.rows[0] ?? null,
    nextVisit: next.rows[0] ? { date: next.rows[0].date, service: next.rows[0].service, appointmentId: next.rows[0].appointment_id } : null,
    vaccines: vaccines.rows
      .map((v) => ({
        name: v.name,
        administeredAt: v.administered_at,
        dueAt: v.due_at,
        state: (v.due_at < today ? "overdue" : v.due_at <= soon ? "due_soon" : "current") as HealthSummary["vaccines"][number]["state"],
      }))
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt)),
    prevention: prevention.rows.map((p) => ({
      product: p.product,
      supplyEndAt: p.supply_end_at,
      state: (p.supply_end_at < today ? "ended" : p.supply_end_at <= addDays(today, 14) ? "ending_soon" : "current") as HealthSummary["prevention"][number]["state"],
    })),
    latestWeight: weight.rows[0] ? { kg: Number(weight.rows[0].kg), measuredOn: weight.rows[0].measured_on } : null,
  };
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Weights oldest first, for the trend chart (the last 24 measurements). */
export async function weightHistory(db: SqlClient, locationId: string, patientId: string): Promise<{ measuredOn: string; kg: number; source: string }[]> {
  await assertPet(db, locationId, patientId);
  const { rows } = await db.query<{ measured_on: string; kg: string; source: string }>(
    `SELECT * FROM (
       SELECT to_char(measured_on, 'YYYY-MM-DD') AS measured_on, weight_kg::text AS kg, source, measured_on AS d, created_at
       FROM patient_weights WHERE patient_id = $1 ORDER BY measured_on DESC, created_at DESC LIMIT 24
     ) w ORDER BY d, created_at`,
    [patientId],
  );
  return rows.map((r) => ({ measuredOn: r.measured_on, kg: Number(r.kg), source: r.source }));
}

export interface HistoryEntry {
  id: string;
  kind: HistoryKind;
  /** When it happened. Date-only entries (vaccines, weights) are at midnight UTC: show the date only. */
  at: Date;
  dateOnly: boolean;
  title: string;
  detail: string | null;
  /** Kind-specific state: visit status, triage level, message status, task status. */
  status: string | null;
  source: HistorySource;
  /** In-app link to the full record, when there is one. */
  href: string | null;
}

// One SELECT per kind, all returning the same columns. $1 pet, $2 location.
const KIND_SQL: Record<HistoryKind, string> = {
  visit: `SELECT a.id::text, 'visit' AS kind, a.start_at AS at, false AS date_only, s.name AS title,
            concat_ws(' · ', pr.display_name, nullif(a.reason_text, '')) AS detail, a.status, 'clinic' AS source,
            '/schedule?date=' || to_char(a.start_at AT TIME ZONE l.timezone, 'YYYY-MM-DD') || '&visit=' || a.id AS href
          FROM appointments a JOIN services s ON s.id = a.service_id JOIN locations l ON l.id = a.location_id
          LEFT JOIN providers pr ON pr.id = a.provider_id
          WHERE a.patient_id = $1 AND a.location_id = $2`,
  vaccine: `SELECT v.id::text, 'vaccine', v.administered_at::timestamptz, true, vt.name,
              'Next due ' || to_char(v.due_at, 'FMMon FMDD, YYYY'), CASE WHEN v.administered_by = 'external' THEN 'external' END, 'clinic', NULL
            FROM vaccine_records v JOIN vaccine_types vt ON vt.id = v.vaccine_id WHERE v.patient_id = $1`,
  prevention: `SELECT pp.id::text, 'prevention', pp.supply_start_at::timestamptz, true, pp.product_name,
                 pp.doses_supplied || ' doses, supply until ' || to_char(pp.supply_end_at, 'FMMon FMDD, YYYY'), pp.product_type, 'clinic', NULL
               FROM prevention_products pp WHERE pp.patient_id = $1`,
  weight: `SELECT w.id::text, 'weight', w.measured_on::timestamptz, true, trim(trailing '.' FROM trim(trailing '0' FROM w.weight_kg::text)) || ' kg',
             CASE w.source WHEN 'visit' THEN 'Weighed at a visit' WHEN 'staff' THEN 'Entered by staff' ELSE 'From the clinic''s records' END,
             w.source, CASE WHEN w.source = 'import' THEN 'system' ELSE 'clinic' END, NULL
           FROM patient_weights w WHERE w.patient_id = $1`,
  call: `SELECT c.id::text, 'call', c.started_at, false,
           CASE c.channel WHEN 'sms' THEN 'Text conversation' WHEN 'web' THEN 'Web chat' ELSE CASE c.direction WHEN 'outbound' THEN 'Outbound call' ELSE 'Phone call' END END,
           c.summary, c.triage_level, 'owner', '/calls/' || c.id
         FROM calls c WHERE c.patient_id = $1 AND c.location_id = $2`,
  message: `SELECT m.id::text, 'message', m.created_at, false,
              CASE m.channel WHEN 'email' THEN coalesce(m.subject, 'Email') WHEN 'ai_call' THEN 'Reminder call' ELSE 'Text' END,
              CASE WHEN length(m.body) > 160 THEN rtrim(left(m.body, 159)) || '…' ELSE m.body END, m.status, CASE WHEN m.sent_by IS NOT NULL THEN 'clinic' ELSE 'system' END, '/messages/' || m.client_id
            FROM messages m WHERE m.patient_id = $1 AND m.location_id = $2`,
  task: `SELECT t.id::text, 'task', t.created_at, false, coalesce(t.title, replace(t.type, '_', ' ')),
           CASE WHEN length(t.details) > 160 THEN rtrim(left(t.details, 159)) || '…' ELSE t.details END, t.status, CASE WHEN t.call_id IS NOT NULL THEN 'ai' ELSE 'system' END, '/tasks'
         FROM staff_tasks t WHERE t.patient_id = $1 AND t.location_id = $2`,
};

/**
 * The timeline, newest first, `limit` at a time. `before` is the `next`
 * cursor of the previous page. Only the given kinds are read, so a filter or
 * a missing permission never loads rows that are then hidden.
 */
export async function patientTimeline(
  db: SqlClient,
  locationId: string,
  patientId: string,
  options: { kinds: HistoryKind[]; before?: string | null; limit?: number },
): Promise<{ entries: HistoryEntry[]; next: string | null }> {
  await assertPet(db, locationId, patientId);
  const kinds = options.kinds.filter((k) => k in KIND_SQL);
  if (kinds.length === 0) return { entries: [], next: null };
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
  const cursor = parseCursor(options.before);
  const params: unknown[] = [patientId, locationId, limit + 1];
  let where = "";
  if (cursor) {
    params.push(cursor.at, cursor.id);
    where = `WHERE (h.at, h.id) < ($4::timestamptz, $5::text)`;
  }
  const { rows } = await db.query<{
    id: string; kind: HistoryKind; at: Date; date_only: boolean; title: string; detail: string | null;
    status: string | null; source: HistorySource; href: string | null;
  }>(
    // The CTE types $2 for every filter: vaccines, prevention and weights do not use it,
    // and Postgres refuses a parameter it cannot type.
    `WITH p AS (SELECT $1::uuid AS patient_id, $2::uuid AS location_id)
     SELECT h.* FROM (${kinds.map((k) => KIND_SQL[k]).join("\nUNION ALL\n")})
       AS h (id, kind, at, date_only, title, detail, status, source, href)
     ${where}
     ORDER BY h.at DESC, h.id DESC
     LIMIT $3`,
    params,
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    entries: page.map((r) => ({
      id: r.id, kind: r.kind, at: r.at, dateOnly: r.date_only, title: r.title, detail: r.detail,
      status: r.status, source: r.source, href: r.href,
    })),
    next: rows.length > limit && last ? `${last.at.toISOString()}~${last.id}` : null,
  };
}

function parseCursor(value: string | null | undefined): { at: string; id: string } | null {
  if (!value) return null;
  const [at, id] = value.split("~");
  if (!at || !id || Number.isNaN(Date.parse(at)) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { at, id };
}
