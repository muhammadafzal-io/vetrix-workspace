// Visit records: notes, recommendations, prescriptions and photos staff add
// to one visit (approved 26 Nov 2026, a change to the V1 scope). They are
// clinical records, so nothing is hard-deleted (a wrong entry is voided with
// a reason), edits are audited with the old text, and the AI front desk
// never reads them. Pure rules only; storage is in @vetrix/db.
import { RuleViolationError, ValidationError } from "./errors";

/** Visits that accept records: the pet is here or has been seen. */
export const RECORDABLE_VISIT_STATUSES = ["checked_in", "in_progress", "completed"] as const;

export function assertVisitAcceptsRecords(status: string): void {
  if (!(RECORDABLE_VISIT_STATUSES as readonly string[]).includes(status)) {
    throw new RuleViolationError(
      "visit_record.status",
      status === "cancelled" || status === "no_show"
        ? "This visit did not happen, so it has no record."
        : "Add notes once the pet is checked in.",
    );
  }
}

// ---------- Notes and recommendations ----------

export const VISIT_ENTRY_KINDS = ["note", "recommendation"] as const;
export type VisitEntryKind = (typeof VISIT_ENTRY_KINDS)[number];
export const VISIT_ENTRY_LABEL: Record<VisitEntryKind, string> = { note: "Note", recommendation: "Recommendation" };

export const VISIT_RECORD_LIMITS = {
  entryChars: 10_000,
  /** The author may edit an entry for this long; after that it can only be voided. */
  editWindowHours: 24,
  /** A follow-up date at most this many days ahead. */
  followUpDays: 730,
  voidReasonChars: 300,
} as const;

export interface VisitEntryInput {
  kind?: string | null;
  body?: string | null;
  /** YYYY-MM-DD, recommendations only. */
  followUpOn?: string | null;
}

export interface ValidVisitEntry {
  kind: VisitEntryKind;
  body: string;
  followUpOn: string | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isRealDate(value: string): boolean {
  return DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

/** `today` is the clinic's date (YYYY-MM-DD). */
export function validateVisitEntry(input: VisitEntryInput, today: string): ValidVisitEntry {
  const kind = input.kind as VisitEntryKind;
  if (!(VISIT_ENTRY_KINDS as readonly string[]).includes(kind)) {
    throw new ValidationError("Choose note or recommendation.", { field: "kind" });
  }
  const body = (input.body ?? "").replace(/\r\n/g, "\n").trim();
  if (!body) throw new ValidationError(`Write the ${VISIT_ENTRY_LABEL[kind].toLowerCase()}.`, { field: "body" });
  if (body.length > VISIT_RECORD_LIMITS.entryChars) {
    throw new ValidationError(`Keep it under ${VISIT_RECORD_LIMITS.entryChars.toLocaleString("en-US")} characters.`, { field: "body" });
  }
  const raw = (input.followUpOn ?? "").trim();
  let followUpOn: string | null = null;
  if (raw) {
    if (kind !== "recommendation") throw new ValidationError("Only a recommendation has a follow-up date.", { field: "followUpOn" });
    if (!isRealDate(raw)) throw new ValidationError("Enter a valid follow-up date.", { field: "followUpOn" });
    if (raw < today) throw new ValidationError("The follow-up date is in the past.", { field: "followUpOn" });
    if (raw > addDays(today, VISIT_RECORD_LIMITS.followUpDays)) {
      throw new ValidationError("Choose a follow-up date within two years.", { field: "followUpOn" });
    }
    followUpOn = raw;
  }
  return { kind, body, followUpOn };
}

/**
 * Only the author may edit, and only within the edit window. After that a
 * wrong entry is voided and a new one added, so the record shows both.
 */
export function assertCanEditEntry(input: { authorId: string | null; actorId: string | null; createdAt: Date; now: Date; voided: boolean }): void {
  if (input.voided) throw new RuleViolationError("visit_record.voided", "This entry was removed, so it can't be edited.");
  if (!input.actorId || input.authorId !== input.actorId) {
    throw new RuleViolationError("visit_record.not_author", "Only the person who wrote this can edit it. Add a new entry instead.");
  }
  if (input.now.getTime() - input.createdAt.getTime() > VISIT_RECORD_LIMITS.editWindowHours * 3_600_000) {
    throw new RuleViolationError(
      "visit_record.edit_window",
      `Entries can be edited for ${VISIT_RECORD_LIMITS.editWindowHours} hours. Remove it with a reason and add a new one.`,
    );
  }
}

/** Removing any record needs a reason; it stays in the database, hidden. */
export function validateVoidReason(raw: string | null | undefined): string {
  const reason = (raw ?? "").trim();
  if (reason.length < 3) throw new ValidationError("Say why it is being removed.", { field: "reason" });
  if (reason.length > VISIT_RECORD_LIMITS.voidReasonChars) {
    throw new ValidationError(`Keep the reason under ${VISIT_RECORD_LIMITS.voidReasonChars} characters.`, { field: "reason" });
  }
  return reason;
}

// ---------- Prescriptions ----------

export const PRESCRIPTION_ROUTES = ["oral", "topical", "injection", "ophthalmic", "otic", "inhaled", "other"] as const;
export type PrescriptionRoute = (typeof PRESCRIPTION_ROUTES)[number];
export const PRESCRIPTION_ROUTE_LABEL: Record<PrescriptionRoute, string> = {
  oral: "By mouth",
  topical: "On the skin",
  injection: "Injection",
  ophthalmic: "Eye",
  otic: "Ear",
  inhaled: "Inhaled",
  other: "Other",
};

export interface PrescriptionInput {
  drugName?: string | null;
  strength?: string | null;
  dose?: string | null;
  route?: string | null;
  frequency?: string | null;
  durationDays?: string | number | null;
  quantity?: string | null;
  refills?: string | number | null;
  instructions?: string | null;
  controlled?: boolean | null;
  /** providers.id of the prescribing doctor. */
  prescribedBy?: string | null;
}

export interface ValidPrescription {
  drugName: string;
  strength: string | null;
  dose: string;
  route: PrescriptionRoute | null;
  frequency: string;
  durationDays: number | null;
  quantity: string | null;
  refills: number;
  instructions: string | null;
  controlled: boolean;
  prescribedBy: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value: string | null | undefined, field: string, label: string, max: number, required: boolean): string | null {
  const v = (value ?? "").trim();
  if (!v) {
    if (required) throw new ValidationError(`Enter the ${label}.`, { field });
    return null;
  }
  if (v.length > max) throw new ValidationError(`Keep the ${label} under ${max} characters.`, { field });
  return v;
}

function wholeNumber(value: string | number | null | undefined, field: string, label: string, min: number, max: number): number | null {
  const raw = typeof value === "number" ? String(value) : (value ?? "").trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    throw new ValidationError(`${label} must be a whole number from ${min} to ${max}.`, { field });
  }
  return Number(raw);
}

/** `doctorIds` are the location's providers with the doctor role. */
export function validatePrescription(input: PrescriptionInput, doctorIds: ReadonlySet<string>): ValidPrescription {
  const route = (input.route ?? "").trim();
  if (route && !(PRESCRIPTION_ROUTES as readonly string[]).includes(route)) {
    throw new ValidationError("Choose how it is given.", { field: "route" });
  }
  const prescribedBy = (input.prescribedBy ?? "").trim().toLowerCase();
  if (!UUID.test(prescribedBy) || !doctorIds.has(prescribedBy)) {
    throw new ValidationError("Choose the doctor who prescribed it.", { field: "prescribedBy" });
  }
  return {
    drugName: text(input.drugName, "drugName", "medicine name", 200, true)!,
    strength: text(input.strength, "strength", "strength", 100, false),
    dose: text(input.dose, "dose", "dose", 200, true)!,
    route: (route || null) as PrescriptionRoute | null,
    frequency: text(input.frequency, "frequency", "how often", 200, true)!,
    durationDays: wholeNumber(input.durationDays, "durationDays", "Days", 1, 3650),
    quantity: text(input.quantity, "quantity", "quantity", 100, false),
    refills: wholeNumber(input.refills, "refills", "Refills", 0, 12) ?? 0,
    instructions: text(input.instructions, "instructions", "instructions", 2000, false),
    controlled: input.controlled === true,
    prescribedBy,
  };
}

// ---------- Photos ----------

export const VISIT_PHOTO_LIMITS = {
  /** Size of the file staff upload. */
  maxUploadBytes: 10 * 1024 * 1024,
  maxPerVisit: 20,
  /** Stored photos are resized to fit this (long edge, px). */
  maxEdge: 2400,
  thumbEdge: 400,
  /** Refuse images that would decode to more pixels than this (decompression bombs). */
  maxPixels: 40_000_000,
} as const;

export type VisitPhotoType = "image/jpeg" | "image/png" | "image/webp";

/**
 * The image type from the file's first bytes. The name and the browser's
 * type are not trusted: a renamed file is still what its bytes say.
 * HEIC (iPhone) is not accepted yet: phones share as JPEG by default.
 */
export function detectPhotoType(bytes: Uint8Array): VisitPhotoType | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return "image/png";
  }
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return "image/webp";
  }
  return null;
}

export interface VisitPhotoInput {
  bytes: Uint8Array;
  bodyArea?: string | null;
  caption?: string | null;
  /** Photos already on this visit (not voided). */
  existingCount: number;
}

/** Checks an upload before it is processed. Returns the detected type and the cleaned labels. */
export function validateVisitPhoto(input: VisitPhotoInput): { type: VisitPhotoType; bodyArea: string | null; caption: string | null } {
  if (input.bytes.length === 0) throw new ValidationError("Choose a photo.", { field: "photo" });
  if (input.bytes.length > VISIT_PHOTO_LIMITS.maxUploadBytes) throw new ValidationError("Photos can be up to 10 MB.", { field: "photo" });
  const type = detectPhotoType(input.bytes);
  if (!type) throw new ValidationError("Upload a JPEG, PNG or WebP photo.", { field: "photo" });
  if (input.existingCount >= VISIT_PHOTO_LIMITS.maxPerVisit) {
    throw new RuleViolationError("visit_record.photo_limit", `A visit can have up to ${VISIT_PHOTO_LIMITS.maxPerVisit} photos.`);
  }
  return {
    type,
    bodyArea: text(input.bodyArea, "bodyArea", "body area", 100, false),
    caption: text(input.caption, "caption", "caption", 500, false),
  };
}

/** Where a photo is stored: one folder per organization, location and pet. */
export function visitPhotoKeys(input: { organizationId: string; locationId: string; patientId: string; photoId: string }): { original: string; thumb: string } {
  for (const id of Object.values(input)) {
    if (!UUID.test(id)) throw new ValidationError("Bad photo key.");
  }
  const base = `orgs/${input.organizationId}/locations/${input.locationId}/patients/${input.patientId}/visit-photos/${input.photoId}`;
  return { original: `${base}.jpg`, thumb: `${base}-thumb.jpg` };
}
