// One visit's record: notes, recommendations, prescriptions and photos.
// Needs records.view; adding needs records.write (records.prescribe for
// prescriptions). Removed entries are hidden unless "Show removed" is on;
// they are never deleted.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ClipboardList, ImageIcon, Pill, ShieldAlert } from "lucide-react";
import { PRESCRIPTION_ROUTE_LABEL, VISIT_ENTRY_LABEL, VISIT_RECORD_LIMITS, type PrescriptionRoute } from "@vetrix/domain";
import { loadVisitRecord, type VisitEntryRow } from "@vetrix/db/runtime";
import { Panel } from "@/components/patterns/detail-list";
import { PageHeader } from "@/components/patterns/page-header";
import { Badge } from "@/components/ui/badge";
import { assertId, orNotFound, requirePage } from "@/features/clients/access";
import { addEntryAction, addPrescriptionAction, editEntryAction, readPrescriptionAction, tidyNoteAction, uploadPhotoAction, voidRecordAction } from "@/features/visit-records/actions";
import { aiMode } from "@/lib/ai";
import { EntryEdit, EntryForm, PhotoUpload, PrescriptionForm, RemoveRecord } from "@/features/visit-records/record-forms";
import { clinicToday, formatDate } from "@/lib/clinic-date";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Visit record · Vetrix" };

const STATUS_LABEL: Record<string, string> = {
  requested: "Not confirmed",
  confirmed: "Booked",
  checked_in: "Checked in",
  in_progress: "In progress",
  completed: "Completed",
  no_show: "No-show",
  cancelled: "Cancelled",
};

function Removed({ row }: { row: { voidedAt: Date | null; voidReason: string | null } }) {
  if (!row.voidedAt) return null;
  return <Badge variant="muted">Removed: {row.voidReason}</Badge>;
}

export default async function VisitRecordPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; visitId: string }>;
  searchParams: Promise<{ removed?: string }>;
}) {
  const shell = await requirePage("records.view");
  const { id, visitId } = await params;
  const patientId = assertId(id);
  const appointmentId = assertId(visitId);
  const showRemoved = (await searchParams).removed === "1";
  const record = await orNotFound(loadVisitRecord(shell.clinic, shell.location.id, appointmentId, { includeVoided: showRemoved }));
  if (record.visit.patientId !== patientId) notFound();

  const { visit } = record;
  const tz = shell.location.timezone;
  const today = clinicToday(tz);
  const me = shell.access.staffUserId;
  const now = Date.now();
  const recordable = ["checked_in", "in_progress", "completed"].includes(visit.status);
  const canWrite = recordable && shell.permissions.has("records.write");
  const canPrescribe = recordable && shell.permissions.has("records.prescribe");
  const canEdit = (e: VisitEntryRow) =>
    canWrite && !e.voidedAt && e.authorId === me && now - e.createdAt.getTime() <= VISIT_RECORD_LIMITS.editWindowHours * 3_600_000;
  const at = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: tz, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(d);
  const self = `/patients/${patientId}/visits/${appointmentId}`;
  // "Tidy with AI" needs the OpenAI key; quick prescription entry also works with Sandbox rules.
  const tidy = aiMode() === "openai" ? tidyNoteAction.bind(null, appointmentId) : undefined;
  const defaultDoctor = record.doctors.some((d) => d.id === visit.providerId) ? visit.providerId : null;

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-3 text-small text-muted-foreground">
        <Link href="/patients" className="hover:text-foreground hover:underline">
          Patients
        </Link>{" "}
        /{" "}
        <Link href={`/patients/${patientId}?tab=history`} className="hover:text-foreground hover:underline">
          {visit.patientName}
        </Link>{" "}
        / <span className="text-foreground">Visit record</span>
      </nav>
      <PageHeader
        title={`${visit.service}, ${formatDate(visit.visitDate)}`}
        description={[visit.patientName, visit.clientName, visit.providerName, STATUS_LABEL[visit.status] ?? visit.status].filter(Boolean).join(" · ")}
      />

      <div role="note" className="mb-5 flex gap-3 rounded-lg border bg-muted/50 p-4 text-small">
        <ShieldAlert className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
        <p>
          Clinical record for staff only: never shared with the owner or the AI. Entries can&apos;t be deleted. A wrong one is removed with a reason and stays in
          the history.{" "}
          <Link href={showRemoved ? self : `${self}?removed=1`} scroll={false} className="font-medium text-primary hover:underline">
            {showRemoved ? "Hide removed" : "Show removed"}
          </Link>
        </p>
      </div>
      {!recordable && (
        <p className="mb-5 rounded-lg border border-warning/40 bg-warning-soft p-4 text-small text-warning-text">
          {visit.status === "cancelled" || visit.status === "no_show"
            ? "This visit did not happen, so nothing can be added."
            : "Notes, prescriptions and photos can be added once the pet is checked in."}
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-5">
          <Panel title="Notes and recommendations">
            {record.entries.length === 0 ? (
              <p className="text-small text-muted-foreground">Nothing written yet.</p>
            ) : (
              <ul className="grid gap-3">
                {record.entries.map((e) => (
                  <li key={e.id} className={cn("grid gap-2 rounded-lg border p-3", e.voidedAt && "opacity-60")}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={e.kind === "recommendation" ? "secondary" : "muted"}>
                        <ClipboardList className="size-3" aria-hidden /> {VISIT_ENTRY_LABEL[e.kind]}
                      </Badge>
                      {e.followUpOn && <Badge variant="warning">Follow up {formatDate(e.followUpOn)}</Badge>}
                      <Removed row={e} />
                    </div>
                    <p className={cn("whitespace-pre-line text-small", e.voidedAt && "line-through")}>{e.body}</p>
                    <p className="text-caption text-muted-foreground">
                      {e.authorName ?? "Staff"} · {at(e.createdAt)}
                      {e.updatedAt.getTime() - e.createdAt.getTime() > 1000 && ` · edited ${at(e.updatedAt)}`}
                    </p>
                    {!e.voidedAt && canWrite && (
                      <div className="flex flex-wrap gap-1">
                        {canEdit(e) && (
                          <EntryEdit
                            action={editEntryAction.bind(null, patientId, appointmentId, e.id)}
                            body={e.body}
                            followUpOn={e.followUpOn}
                            isRecommendation={e.kind === "recommendation"}
                            tidy={tidy}
                          />
                        )}
                        <RemoveRecord action={voidRecordAction.bind(null, patientId, appointmentId, "entry", e.id)} what={VISIT_ENTRY_LABEL[e.kind].toLowerCase()} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canWrite && (
              <div className="border-t pt-4">
                <EntryForm action={addEntryAction.bind(null, patientId, appointmentId)} today={today} tidy={tidy} />
              </div>
            )}
          </Panel>

          <Panel title="Prescriptions">
            {record.prescriptions.length === 0 ? (
              <p className="text-small text-muted-foreground">No prescriptions for this visit.</p>
            ) : (
              <ul className="grid gap-3">
                {record.prescriptions.map((p) => (
                  <li key={p.id} className={cn("grid gap-1.5 rounded-lg border p-3", p.voidedAt && "opacity-60")}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Pill className="size-4 text-primary" aria-hidden />
                      <span className={cn("font-medium", p.voidedAt && "line-through")}>
                        {p.drugName}
                        {p.strength && ` ${p.strength}`}
                      </span>
                      {p.controlled && <Badge variant="danger">Controlled</Badge>}
                      <Removed row={p} />
                    </div>
                    <p className="text-small">
                      {[p.dose, p.route ? PRESCRIPTION_ROUTE_LABEL[p.route as PrescriptionRoute] : null, p.frequency, p.durationDays ? `for ${p.durationDays} day${p.durationDays === 1 ? "" : "s"}` : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    <p className="text-caption text-muted-foreground">
                      {[p.quantity ? `Quantity ${p.quantity}` : null, `${p.refills} refill${p.refills === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}
                    </p>
                    {p.instructions && <p className="whitespace-pre-line text-small text-muted-foreground">{p.instructions}</p>}
                    <p className="text-caption text-muted-foreground">
                      Prescribed by {p.prescriberName} · recorded by {p.recordedByName ?? "staff"} · {at(p.createdAt)}
                    </p>
                    {!p.voidedAt && canPrescribe && <RemoveRecord action={voidRecordAction.bind(null, patientId, appointmentId, "prescription", p.id)} what="prescription" />}
                  </li>
                ))}
              </ul>
            )}
            {canPrescribe && (
              <div className="border-t pt-4">
                <PrescriptionForm action={addPrescriptionAction.bind(null, patientId, appointmentId)} doctors={record.doctors} defaultDoctor={defaultDoctor} readRx={readPrescriptionAction} />
              </div>
            )}
          </Panel>
        </div>

        <Panel title="Photos">
          {record.photos.length === 0 ? (
            <p className="flex items-center gap-2 text-small text-muted-foreground">
              <ImageIcon className="size-4" aria-hidden /> No photos for this visit.
            </p>
          ) : (
            <ul className="grid grid-cols-2 gap-3">
              {record.photos.map((ph) => (
                <li key={ph.id} className={cn("grid content-start gap-1.5", ph.voidedAt && "opacity-60")}>
                  {ph.voidedAt ? (
                    <div className="flex aspect-square items-center justify-center rounded-lg border bg-muted text-caption text-muted-foreground">Removed</div>
                  ) : (
                    <a href={`/api/visit-photos/${ph.id}`} target="_blank" rel="noopener" className="block overflow-hidden rounded-lg border hover:opacity-90">
                      {/* eslint-disable-next-line @next/next/no-img-element -- private, permission-checked image; next/image would cache it on the server */}
                      <img
                        src={`/api/visit-photos/${ph.id}?size=thumb`}
                        alt={[ph.bodyArea, ph.caption].filter(Boolean).join(": ") || `Photo of ${visit.patientName}`}
                        width={ph.width}
                        height={ph.height}
                        loading="lazy"
                        className="aspect-square w-full object-cover"
                      />
                    </a>
                  )}
                  {ph.bodyArea && <span className="text-small font-medium">{ph.bodyArea}</span>}
                  {ph.caption && <span className="text-caption text-muted-foreground">{ph.caption}</span>}
                  <span className="text-caption text-muted-foreground">
                    {ph.uploadedByName ?? "Staff"} · {at(ph.createdAt)}
                  </span>
                  <Removed row={ph} />
                  {!ph.voidedAt && canWrite && <RemoveRecord action={voidRecordAction.bind(null, patientId, appointmentId, "photo", ph.id)} what="photo" />}
                </li>
              ))}
            </ul>
          )}
          {canWrite && (
            <div className="border-t pt-4">
              <PhotoUpload action={uploadPhotoAction.bind(null, patientId, appointmentId)} />
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
