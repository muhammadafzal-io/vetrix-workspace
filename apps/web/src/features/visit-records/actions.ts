"use server";

// Server actions for visit records. Each one: checks the person's permission
// at the active location, lets @vetrix/db (rules from @vetrix/domain) check
// and save in one transaction, and records who did it. Photos are processed
// and stored before their row is saved; if the row is not saved, the stored
// files are removed again.
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { ForbiddenError, RuleViolationError, ValidationError, VISIT_AI_MAX_INPUT, visitPhotoKeys, type ParsedPrescription, type Permission } from "@vetrix/domain";
import {
  addPrescription,
  addVisitEntry,
  checkVisitPhoto,
  editVisitEntry,
  getVisitHeader,
  recordVisitPhoto,
  voidVisitRecord,
  withTransaction,
  type Actor,
} from "@vetrix/db/runtime";
import { formValues, toActionError, type ActionResult } from "@/lib/action-result";
import { readPrescriptionLine, tidyVisitNote } from "@/lib/ai";
import { createLimiter } from "@/lib/rate-limit";
import { fileStore } from "@/lib/file-store";
import { logger } from "@/lib/logger";
import { processVisitPhoto } from "@/lib/photo-processing";
import { requireShell } from "@/lib/session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function allowed(permission: Permission) {
  const shell = await requireShell();
  if (!shell.permissions.has(permission)) throw new ForbiddenError();
  const actor: Actor = { type: "staff", id: shell.access.staffUserId };
  return { shell, actor };
}

function id(value: string): string {
  if (!UUID.test(value)) throw new ValidationError("That record no longer exists.");
  return value;
}

const str = (f: FormData, key: string) => String(f.get(key) ?? "");
/** Set by the form when staff used an AI draft; recorded in the audit log. */
const aiAssisted = (f: FormData) => f.get("aiAssisted") === "1";

function refresh(patientId: string, visitId: string) {
  revalidatePath(`/patients/${patientId}/visits/${visitId}`);
  revalidatePath(`/patients/${patientId}`);
}

export async function addEntryAction(patientId: string, visitId: string, _: ActionResult | null, f: FormData): Promise<ActionResult> {
  try {
    const { shell, actor } = await allowed("records.write");
    await withTransaction(shell.clinic, (tx) =>
      addVisitEntry(tx, {
        locationId: shell.location.id,
        appointmentId: id(visitId),
        actor,
        entry: { kind: str(f, "kind"), body: str(f, "body"), followUpOn: str(f, "followUpOn") },
        aiAssisted: aiAssisted(f),
      }),
    );
  } catch (error) {
    return { ...toActionError(error), values: formValues(f) } as ActionResult;
  }
  refresh(patientId, visitId);
  return { ok: true, message: "Saved." };
}

export async function editEntryAction(patientId: string, visitId: string, entryId: string, _: ActionResult | null, f: FormData): Promise<ActionResult> {
  try {
    const { shell, actor } = await allowed("records.write");
    await withTransaction(shell.clinic, (tx) =>
      editVisitEntry(tx, { locationId: shell.location.id, entryId: id(entryId), body: str(f, "body"), followUpOn: str(f, "followUpOn"), actor, now: new Date(), aiAssisted: aiAssisted(f) }),
    );
  } catch (error) {
    return { ...toActionError(error), values: formValues(f) } as ActionResult;
  }
  refresh(patientId, visitId);
  return { ok: true, message: "Saved." };
}

const VOID_TABLES = { entry: "visit_entries", prescription: "visit_prescriptions", photo: "visit_photos" } as const;
export type VoidKind = keyof typeof VOID_TABLES;

/** Removing a prescription needs the prescribing permission; notes and photos need records.write. */
export async function voidRecordAction(patientId: string, visitId: string, kind: VoidKind, recordId: string, _: ActionResult | null, f: FormData): Promise<ActionResult> {
  try {
    if (!(kind in VOID_TABLES)) throw new ValidationError("Choose what to remove.");
    const { shell, actor } = await allowed(kind === "prescription" ? "records.prescribe" : "records.write");
    await withTransaction(shell.clinic, (tx) =>
      voidVisitRecord(tx, { locationId: shell.location.id, table: VOID_TABLES[kind], id: id(recordId), reason: str(f, "reason"), actor }),
    );
  } catch (error) {
    return { ...toActionError(error), values: formValues(f) } as ActionResult;
  }
  refresh(patientId, visitId);
  return { ok: true, message: "Removed. It stays in the record history." };
}

export async function addPrescriptionAction(patientId: string, visitId: string, _: ActionResult | null, f: FormData): Promise<ActionResult> {
  try {
    const { shell, actor } = await allowed("records.prescribe");
    await withTransaction(shell.clinic, (tx) =>
      addPrescription(tx, {
        locationId: shell.location.id,
        appointmentId: id(visitId),
        actor,
        prescription: {
          drugName: str(f, "drugName"),
          strength: str(f, "strength"),
          dose: str(f, "dose"),
          route: str(f, "route"),
          frequency: str(f, "frequency"),
          durationDays: str(f, "durationDays"),
          quantity: str(f, "quantity"),
          refills: str(f, "refills"),
          instructions: str(f, "instructions"),
          controlled: f.get("controlled") === "on",
          prescribedBy: str(f, "prescribedBy"),
        },
        aiAssisted: aiAssisted(f),
      }),
    );
  } catch (error) {
    return { ...toActionError(error), values: formValues(f) } as ActionResult;
  }
  refresh(patientId, visitId);
  return { ok: true, message: "Prescription saved." };
}

export async function uploadPhotoAction(patientId: string, visitId: string, _: ActionResult | null, f: FormData): Promise<ActionResult> {
  const stored: string[] = [];
  let store: Awaited<ReturnType<typeof fileStore>> | undefined;
  try {
    const { shell, actor } = await allowed("records.write");
    const appointmentId = id(visitId);
    const file = f.get("photo");
    if (!(file instanceof File) || file.size === 0) throw new ValidationError("Choose a photo.", { field: "photo" });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const labels = { bodyArea: str(f, "bodyArea"), caption: str(f, "caption") };
    const loc = shell.location.id;

    // 1. Quick check (visit status, photo count, real image type) before any work.
    await withTransaction(shell.clinic, (tx) => checkVisitPhoto(tx, { locationId: loc, appointmentId, photo: { bytes, ...labels } }));
    store = await fileStore();
    // 2. Re-encode without metadata, then store privately.
    const photo = await processVisitPhoto(bytes);
    const photoId = randomUUID();
    const result = await withTransaction(shell.clinic, async (tx) => {
      // 3. Check again under the lock: the visit or count may have changed meanwhile.
      const checked = await checkVisitPhoto(tx, { locationId: loc, appointmentId, photo: { bytes, ...labels } });
      const keys = visitPhotoKeys({ organizationId: shell.organization.organization_id, locationId: loc, patientId: checked.visit.patientId, photoId });
      await store!.put(keys.original, photo.original, "image/jpeg");
      stored.push(keys.original);
      await store!.put(keys.thumb, photo.thumb, "image/jpeg");
      stored.push(keys.thumb);
      // 4. The row. A duplicate image keeps the first copy; the new files are removed below.
      return recordVisitPhoto(tx, {
        locationId: loc, appointmentId, patientId: checked.visit.patientId, photoId, storageKey: keys.original, thumbKey: keys.thumb,
        contentType: "image/jpeg", byteSize: photo.original.length, width: photo.width, height: photo.height, sha256: photo.sha256,
        bodyArea: checked.bodyArea, caption: checked.caption, actor,
      });
    });
    if (result.duplicate) {
      await removeAll(store, stored);
      refresh(patientId, visitId);
      return { ok: true, message: "This photo is already on the visit." };
    }
  } catch (error) {
    if (store && stored.length) await removeAll(store, stored);
    return toActionError(error);
  }
  refresh(patientId, visitId);
  return { ok: true, message: "Photo added." };
}

async function removeAll(store: Awaited<ReturnType<typeof fileStore>>, keys: string[]) {
  for (const key of keys) {
    await store.remove(key).catch((error) => logger.error("could not remove an unsaved photo file", { error, key }));
  }
}

// ---------- AI help (drafts only; staff check and save) ----------

/** Each person may ask for AI help this often: it costs money per call. */
const aiLimiter = createLimiter({ limit: 30, windowMs: 10 * 60_000 });

export type AiDraftResult<T> = { ok: true; draft: T; source: "ai" | "sandbox" } | { ok: false; error: string };

function aiInput(text: string): string {
  const t = text.trim();
  if (!t) throw new ValidationError("Type something first.");
  if (t.length > VISIT_AI_MAX_INPUT) throw new ValidationError(`AI help works on up to ${VISIT_AI_MAX_INPUT.toLocaleString("en-US")} characters at a time.`);
  return t;
}

function limited(staffUserId: string) {
  if (!aiLimiter.take(staffUserId)) throw new RuleViolationError("ai.rate_limit", "That's a lot of AI requests. Wait a few minutes and try again.");
}

export async function tidyNoteAction(visitId: string, kind: string, text: string): Promise<AiDraftResult<string>> {
  try {
    const { shell } = await allowed("records.write");
    const input = aiInput(text);
    if (kind !== "note" && kind !== "recommendation") throw new ValidationError("Choose note or recommendation.");
    limited(shell.access.staffUserId);
    const visit = await getVisitHeader(shell.clinic, shell.location.id, id(visitId));
    const draft = await tidyVisitNote({ kind, text: input, species: visit.species });
    if (!draft) return { ok: false, error: "AI couldn't tidy this without changing what it says. Your text is unchanged." };
    return { ok: true, draft, source: "ai" };
  } catch (error) {
    const r = toActionError(error);
    return { ok: false, error: r.ok ? "Something went wrong." : r.error };
  }
}

export async function readPrescriptionAction(text: string): Promise<AiDraftResult<ParsedPrescription>> {
  try {
    const { shell } = await allowed("records.prescribe");
    const input = aiInput(text);
    limited(shell.access.staffUserId);
    const read = await readPrescriptionLine(input);
    if (!read) return { ok: false, error: "Couldn't read that line. Fill in the fields below." };
    return { ok: true, draft: read.fields, source: read.source };
  } catch (error) {
    const r = toActionError(error);
    return { ok: false, error: r.ok ? "Something went wrong." : r.error };
  }
}
