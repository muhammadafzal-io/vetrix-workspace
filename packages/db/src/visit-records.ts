// Visit records against a clinic database: notes, recommendations,
// prescriptions and photo details for one visit (rules in
// @vetrix/domain visit-records). Every read checks the visit belongs to the
// location; every write is audited; nothing is hard-deleted. Photo files are
// stored by the web app before recordVisitPhoto saves their details.
// The AI front desk never calls anything here.
import {
  assertCanEditEntry,
  assertVisitAcceptsRecords,
  NotFoundError,
  validatePrescription,
  validateVisitEntry,
  validateVisitPhoto,
  validateVoidReason,
  type PrescriptionInput,
  type VisitEntryInput,
  type VisitEntryKind,
  type VisitPhotoInput,
} from "@vetrix/domain";
import { writeAudit, type Actor } from "./clients";
import type { SqlClient } from "./sql-client";

export interface VisitHeader {
  id: string;
  status: string;
  patientId: string;
  patientName: string;
  species: string;
  clientId: string;
  clientName: string;
  service: string;
  providerId: string | null;
  providerName: string | null;
  startAt: Date;
  /** The visit day in the clinic's time zone (YYYY-MM-DD). */
  visitDate: string;
  timezone: string;
}

async function visitHeader(db: SqlClient, locationId: string, appointmentId: string, lock = false): Promise<VisitHeader> {
  const { rows } = await db.query<{
    id: string; status: string; patient_id: string; patient_name: string; species: string; client_id: string;
    client_name: string; service: string; provider_id: string | null; provider_name: string | null; start_at: Date; visit_date: string; timezone: string;
  }>(
    `SELECT a.id, a.status, a.patient_id, p.name AS patient_name, p.species, a.client_id,
            concat_ws(' ', c.first_name, c.last_name) AS client_name, s.name AS service, a.provider_id, pr.display_name AS provider_name,
            a.start_at, to_char(a.start_at AT TIME ZONE l.timezone, 'YYYY-MM-DD') AS visit_date, l.timezone
     FROM appointments a
     JOIN patients p ON p.id = a.patient_id
     JOIN clients c ON c.id = a.client_id
     JOIN services s ON s.id = a.service_id
     JOIN locations l ON l.id = a.location_id
     LEFT JOIN providers pr ON pr.id = a.provider_id
     WHERE a.id = $1 AND a.location_id = $2
     ${lock ? "FOR SHARE OF a" : ""}`,
    [appointmentId, locationId],
  );
  const r = rows[0];
  if (!r) throw new NotFoundError("Visit", appointmentId);
  return {
    id: r.id, status: r.status, patientId: r.patient_id, patientName: r.patient_name, species: r.species, clientId: r.client_id,
    clientName: r.client_name, service: r.service, providerId: r.provider_id, providerName: r.provider_name, startAt: r.start_at, visitDate: r.visit_date, timezone: r.timezone,
  };
}

/** The visit's header (pet, species, status), checked against the location. */
export function getVisitHeader(db: SqlClient, locationId: string, appointmentId: string): Promise<VisitHeader> {
  return visitHeader(db, locationId, appointmentId);
}

/** Locks the visit against status changes and checks it accepts records. */
async function recordableVisit(db: SqlClient, locationId: string, appointmentId: string): Promise<VisitHeader> {
  const visit = await visitHeader(db, locationId, appointmentId, true);
  assertVisitAcceptsRecords(visit.status);
  return visit;
}

function staffId(actor: Actor): string | null {
  return actor.type === "staff" ? actor.id : null;
}

/** The clinic's date today (YYYY-MM-DD). */
async function clinicToday(db: SqlClient, locationId: string): Promise<string> {
  const { rows } = await db.query<{ today: string }>(
    `SELECT to_char(now() AT TIME ZONE timezone, 'YYYY-MM-DD') AS today FROM locations WHERE id = $1`,
    [locationId],
  );
  return rows[0]!.today;
}

// ---------- Reads ----------

interface Voidable {
  voidedAt: Date | null;
  voidedBy: string | null;
  voidReason: string | null;
}

export interface VisitEntryRow extends Voidable {
  id: string;
  kind: VisitEntryKind;
  body: string;
  followUpOn: string | null;
  authorId: string | null;
  authorName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface VisitPrescriptionRow extends Voidable {
  id: string;
  drugName: string;
  strength: string | null;
  dose: string;
  route: string | null;
  frequency: string;
  durationDays: number | null;
  quantity: string | null;
  refills: number;
  instructions: string | null;
  controlled: boolean;
  prescribedBy: string;
  prescriberName: string;
  recordedByName: string | null;
  createdAt: Date;
}

export interface VisitPhotoRow extends Voidable {
  id: string;
  width: number;
  height: number;
  byteSize: number;
  bodyArea: string | null;
  caption: string | null;
  uploadedByName: string | null;
  createdAt: Date;
}

export interface VisitRecord {
  visit: VisitHeader;
  entries: VisitEntryRow[];
  prescriptions: VisitPrescriptionRow[];
  photos: VisitPhotoRow[];
  /** Doctors who can be chosen as the prescriber. */
  doctors: { id: string; name: string }[];
}

const VOID_COLUMNS = `t.voided_at AS "voidedAt", t.voided_by AS "voidedBy", t.void_reason AS "voidReason"`;

/** Everything recorded for one visit, oldest first. Removed rows only with `includeVoided`. */
export async function loadVisitRecord(
  db: SqlClient,
  locationId: string,
  appointmentId: string,
  options: { includeVoided?: boolean } = {},
): Promise<VisitRecord> {
  const visit = await visitHeader(db, locationId, appointmentId);
  const live = options.includeVoided ? "" : "AND t.voided_at IS NULL";
  const [entries, prescriptions, photos, doctors] = await Promise.all([
    db.query<VisitEntryRow>(
      `SELECT t.id, t.kind, t.body, to_char(t.follow_up_on, 'YYYY-MM-DD') AS "followUpOn", t.author_id AS "authorId",
              su.display_name AS "authorName", t.created_at AS "createdAt", t.updated_at AS "updatedAt", ${VOID_COLUMNS}
       FROM visit_entries t LEFT JOIN staff_users su ON su.id = t.author_id
       WHERE t.appointment_id = $1 AND t.location_id = $2 ${live}
       ORDER BY t.created_at, t.id`,
      [appointmentId, locationId],
    ),
    db.query<VisitPrescriptionRow>(
      `SELECT t.id, t.drug_name AS "drugName", t.strength, t.dose, t.route, t.frequency, t.duration_days AS "durationDays",
              t.quantity, t.refills, t.instructions, t.controlled, t.prescribed_by AS "prescribedBy", pr.display_name AS "prescriberName",
              su.display_name AS "recordedByName", t.created_at AS "createdAt", ${VOID_COLUMNS}
       FROM visit_prescriptions t JOIN providers pr ON pr.id = t.prescribed_by LEFT JOIN staff_users su ON su.id = t.recorded_by
       WHERE t.appointment_id = $1 AND t.location_id = $2 ${live}
       ORDER BY t.created_at, t.id`,
      [appointmentId, locationId],
    ),
    db.query<VisitPhotoRow>(
      `SELECT t.id, t.width, t.height, t.byte_size AS "byteSize", t.body_area AS "bodyArea", t.caption,
              su.display_name AS "uploadedByName", t.created_at AS "createdAt", ${VOID_COLUMNS}
       FROM visit_photos t LEFT JOIN staff_users su ON su.id = t.uploaded_by
       WHERE t.appointment_id = $1 AND t.location_id = $2 ${live}
       ORDER BY t.created_at, t.id`,
      [appointmentId, locationId],
    ),
    clinicDoctors(db, locationId),
  ]);
  return { visit, entries: entries.rows, prescriptions: prescriptions.rows, photos: photos.rows, doctors };
}

async function clinicDoctors(db: SqlClient, locationId: string): Promise<{ id: string; name: string }[]> {
  const { rows } = await db.query<{ id: string; name: string }>(
    `SELECT id, display_name AS name FROM providers WHERE location_id = $1 AND role = 'dvm' ORDER BY display_name`,
    [locationId],
  );
  return rows;
}

/** Counts per visit for the History tab: only rows that are not removed. */
export async function visitRecordCounts(
  db: SqlClient,
  locationId: string,
  appointmentIds: string[],
): Promise<Map<string, { notes: number; recommendations: number; prescriptions: number; photos: number }>> {
  const out = new Map<string, { notes: number; recommendations: number; prescriptions: number; photos: number }>();
  if (appointmentIds.length === 0) return out;
  const { rows } = await db.query<{ id: string; notes: number; recommendations: number; prescriptions: number; photos: number }>(
    `SELECT a.id,
            (SELECT count(*)::int FROM visit_entries e WHERE e.appointment_id = a.id AND e.kind = 'note' AND e.voided_at IS NULL) AS notes,
            (SELECT count(*)::int FROM visit_entries e WHERE e.appointment_id = a.id AND e.kind = 'recommendation' AND e.voided_at IS NULL) AS recommendations,
            (SELECT count(*)::int FROM visit_prescriptions r WHERE r.appointment_id = a.id AND r.voided_at IS NULL) AS prescriptions,
            (SELECT count(*)::int FROM visit_photos ph WHERE ph.appointment_id = a.id AND ph.voided_at IS NULL) AS photos
     FROM appointments a WHERE a.id = ANY($1::uuid[]) AND a.location_id = $2`,
    [appointmentIds, locationId],
  );
  for (const r of rows) {
    if (r.notes + r.recommendations + r.prescriptions + r.photos > 0) {
      out.set(r.id, { notes: r.notes, recommendations: r.recommendations, prescriptions: r.prescriptions, photos: r.photos });
    }
  }
  return out;
}

// ---------- Notes and recommendations ----------

/** Adds a note or recommendation. Run in a transaction. */
export async function addVisitEntry(
  db: SqlClient,
  input: { locationId: string; appointmentId: string; entry: VisitEntryInput; actor: Actor; aiAssisted?: boolean },
): Promise<{ id: string }> {
  const visit = await recordableVisit(db, input.locationId, input.appointmentId);
  const e = validateVisitEntry(input.entry, await clinicToday(db, input.locationId));
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO visit_entries (location_id, appointment_id, patient_id, kind, body, follow_up_on, author_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [input.locationId, visit.id, visit.patientId, e.kind, e.body, e.followUpOn, staffId(input.actor)],
  );
  const id = rows[0]!.id;
  await writeAudit(db, {
    locationId: input.locationId, actor: input.actor, action: `visit_${e.kind}.added`, entityType: "visit_entry", entityId: id,
    changes: { appointment_id: visit.id, kind: e.kind, length: e.body.length, follow_up_on: e.followUpOn, ai_assisted: input.aiAssisted === true },
  });
  return { id };
}

async function lockEntry(db: SqlClient, locationId: string, entryId: string) {
  const { rows } = await db.query<{ id: string; appointment_id: string; kind: VisitEntryKind; body: string; follow_up_on: string | null; author_id: string | null; created_at: Date; voided_at: Date | null }>(
    `SELECT id, appointment_id, kind, body, to_char(follow_up_on, 'YYYY-MM-DD') AS follow_up_on, author_id, created_at, voided_at
     FROM visit_entries WHERE id = $1 AND location_id = $2 FOR UPDATE`,
    [entryId, locationId],
  );
  if (!rows[0]) throw new NotFoundError("Entry", entryId);
  return rows[0];
}

/** The author edits their own entry within the edit window. The old text goes to the audit log. Run in a transaction. */
export async function editVisitEntry(
  db: SqlClient,
  input: { locationId: string; entryId: string; body: string; followUpOn?: string | null; actor: Actor; now: Date; aiAssisted?: boolean },
): Promise<void> {
  const old = await lockEntry(db, input.locationId, input.entryId);
  assertCanEditEntry({ authorId: old.author_id, actorId: staffId(input.actor), createdAt: old.created_at, now: input.now, voided: old.voided_at !== null });
  const e = validateVisitEntry({ kind: old.kind, body: input.body, followUpOn: input.followUpOn }, await clinicToday(db, input.locationId));
  if (e.body === old.body && e.followUpOn === old.follow_up_on) return;
  await db.query(`UPDATE visit_entries SET body = $2, follow_up_on = $3, updated_at = now() WHERE id = $1`, [old.id, e.body, e.followUpOn]);
  await writeAudit(db, {
    locationId: input.locationId, actor: input.actor, action: `visit_${old.kind}.edited`, entityType: "visit_entry", entityId: old.id,
    changes: { body: [old.body, e.body], follow_up_on: [old.follow_up_on, e.followUpOn], ai_assisted: input.aiAssisted === true },
  });
}

type VoidTable = "visit_entries" | "visit_prescriptions" | "visit_photos";
const VOID_ENTITY: Record<VoidTable, string> = { visit_entries: "visit_entry", visit_prescriptions: "visit_prescription", visit_photos: "visit_photo" };

/** Hides a record with a reason; the row and its file stay. Run in a transaction. */
export async function voidVisitRecord(
  db: SqlClient,
  input: { locationId: string; table: VoidTable; id: string; reason: string; actor: Actor },
): Promise<void> {
  const reason = validateVoidReason(input.reason);
  const table = input.table;
  if (!(table in VOID_ENTITY)) throw new NotFoundError("Record", input.id);
  const { rows } = await db.query<{ id: string; patient_id: string; voided_at: Date | null }>(
    `SELECT id, patient_id, voided_at FROM ${table} WHERE id = $1 AND location_id = $2 FOR UPDATE`,
    [input.id, input.locationId],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError("Record", input.id);
  if (row.voided_at) return;
  await db.query(`UPDATE ${table} SET voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1`, [row.id, staffId(input.actor), reason]);
  if (table === "visit_prescriptions") await refreshActivePrescriptions(db, row.patient_id);
  await writeAudit(db, {
    locationId: input.locationId, actor: input.actor, action: `${VOID_ENTITY[table]}.removed`, entityType: VOID_ENTITY[table], entityId: row.id,
    changes: { reason },
  });
}

// ---------- Prescriptions ----------

/**
 * patients.active_prescriptions (used before the AI books a medication
 * visit) turns on with a prescription, and off when the last one that is
 * still running is removed. A staff-set flag with no prescriptions here is
 * left alone.
 */
async function refreshActivePrescriptions(db: SqlClient, patientId: string): Promise<void> {
  await db.query(
    `UPDATE patients SET active_prescriptions = false
     WHERE id = $1 AND active_prescriptions
       AND EXISTS (SELECT 1 FROM visit_prescriptions WHERE patient_id = $1)
       AND NOT EXISTS (
         SELECT 1 FROM visit_prescriptions
         WHERE patient_id = $1 AND voided_at IS NULL
           AND (duration_days IS NULL OR refills > 0 OR created_at + make_interval(days => duration_days) > now()))`,
    [patientId],
  );
}

/** Records a prescription from a doctor at this location. Run in a transaction. */
export async function addPrescription(
  db: SqlClient,
  input: { locationId: string; appointmentId: string; prescription: PrescriptionInput; actor: Actor; aiAssisted?: boolean },
): Promise<{ id: string }> {
  const visit = await recordableVisit(db, input.locationId, input.appointmentId);
  const doctors = await clinicDoctors(db, input.locationId);
  const p = validatePrescription(input.prescription, new Set(doctors.map((d) => d.id)));
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO visit_prescriptions (location_id, appointment_id, patient_id, drug_name, strength, dose, route, frequency,
       duration_days, quantity, refills, instructions, controlled, prescribed_by, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
    [
      input.locationId, visit.id, visit.patientId, p.drugName, p.strength, p.dose, p.route, p.frequency,
      p.durationDays, p.quantity, p.refills, p.instructions, p.controlled, p.prescribedBy, staffId(input.actor),
    ],
  );
  const id = rows[0]!.id;
  await db.query(`UPDATE patients SET active_prescriptions = true WHERE id = $1`, [visit.patientId]);
  await writeAudit(db, {
    locationId: input.locationId, actor: input.actor, action: "visit_prescription.added", entityType: "visit_prescription", entityId: id,
    changes: { appointment_id: visit.id, ...p, ai_assisted: input.aiAssisted === true },
  });
  return { id };
}

// ---------- Photos ----------

/** Checks an upload against the visit before the file is processed and stored. */
export async function checkVisitPhoto(
  db: SqlClient,
  input: { locationId: string; appointmentId: string; photo: Omit<VisitPhotoInput, "existingCount"> },
): Promise<{ visit: VisitHeader; type: string; bodyArea: string | null; caption: string | null }> {
  const visit = await recordableVisit(db, input.locationId, input.appointmentId);
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM visit_photos WHERE appointment_id = $1 AND voided_at IS NULL`,
    [visit.id],
  );
  return { visit, ...validateVisitPhoto({ ...input.photo, existingCount: rows[0]!.n }) };
}

/**
 * Saves a stored photo's details. Call after the files are in storage and
 * inside a transaction that ran checkVisitPhoto. Returns `duplicate` when
 * the same image is already on this visit (the caller removes the new files).
 */
export async function recordVisitPhoto(
  db: SqlClient,
  input: {
    locationId: string; appointmentId: string; patientId: string; photoId: string; storageKey: string; thumbKey: string;
    contentType: "image/jpeg" | "image/png" | "image/webp"; byteSize: number; width: number; height: number; sha256: string;
    bodyArea: string | null; caption: string | null; actor: Actor;
  },
): Promise<{ id: string; duplicate: boolean }> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO visit_photos (id, location_id, appointment_id, patient_id, storage_key, thumb_key, content_type, byte_size,
       width, height, sha256, body_area, caption, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (appointment_id, sha256) WHERE voided_at IS NULL DO NOTHING
     RETURNING id`,
    [
      input.photoId, input.locationId, input.appointmentId, input.patientId, input.storageKey, input.thumbKey, input.contentType,
      input.byteSize, input.width, input.height, input.sha256, input.bodyArea, input.caption, staffId(input.actor),
    ],
  );
  if (!rows[0]) {
    const existing = await db.query<{ id: string }>(
      `SELECT id FROM visit_photos WHERE appointment_id = $1 AND sha256 = $2 AND voided_at IS NULL`,
      [input.appointmentId, input.sha256],
    );
    return { id: existing.rows[0]!.id, duplicate: true };
  }
  await writeAudit(db, {
    locationId: input.locationId, actor: input.actor, action: "visit_photo.added", entityType: "visit_photo", entityId: input.photoId,
    changes: { appointment_id: input.appointmentId, byte_size: input.byteSize, body_area: input.bodyArea },
  });
  return { id: input.photoId, duplicate: false };
}

/** Where a photo's file is, for the viewing route. Removed photos are not served. */
export async function visitPhotoFile(
  db: SqlClient,
  locationId: string,
  photoId: string,
): Promise<{ storageKey: string; thumbKey: string; contentType: string; patientId: string } | null> {
  const { rows } = await db.query<{ storage_key: string; thumb_key: string; content_type: string; patient_id: string }>(
    `SELECT storage_key, thumb_key, content_type, patient_id FROM visit_photos WHERE id = $1 AND location_id = $2 AND voided_at IS NULL`,
    [photoId, locationId],
  );
  const r = rows[0];
  return r ? { storageKey: r.storage_key, thumbKey: r.thumb_key, contentType: r.content_type, patientId: r.patient_id } : null;
}
