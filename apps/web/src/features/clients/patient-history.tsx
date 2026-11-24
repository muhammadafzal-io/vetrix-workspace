// The pet's History tab: a health overview, the weight trend, and one
// timeline of everything the front desk knows. Each row says where it came
// from (Clinic record, Owner said, AI, Automatic) so nobody mistakes an
// owner's words or an AI judgement for something the clinic recorded.
// Clinical notes, diagnoses and prescriptions stay in the clinic's PIMS.
import Link from "next/link";
import {
  Bell,
  CalendarCheck2,
  ClipboardList,
  History,
  MessageSquare,
  Phone,
  Scale,
  ShieldCheck,
  Syringe,
  type LucideIcon,
} from "lucide-react";
import {
  HISTORY_SOURCE_LABEL,
  historyFiltersFor,
  historyKindsFor,
  type HistoryKind,
  type HistorySource,
  type Permission,
} from "@vetrix/domain";
import { patientHealthSummary, patientTimeline, weightHistory, type HistoryEntry, type SqlClient } from "@vetrix/db/runtime";
import { EmptyState } from "@/components/patterns/empty-state";
import { Panel } from "@/components/patterns/detail-list";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/clinic-date";
import { cn } from "@/lib/utils";

const KIND_ICON: Record<HistoryKind, LucideIcon> = {
  visit: CalendarCheck2,
  vaccine: Syringe,
  prevention: ShieldCheck,
  weight: Scale,
  call: Phone,
  message: MessageSquare,
  task: ClipboardList,
};

const SOURCE_STYLE: Record<HistorySource, string> = {
  clinic: "bg-secondary text-secondary-foreground",
  owner: "bg-info-soft text-foreground",
  ai: "bg-warning-soft text-warning-text",
  system: "bg-muted text-muted-foreground",
};

const VISIT_STATUS: Record<string, { label: string; variant: "success" | "warning" | "muted" | "danger" | "secondary" }> = {
  requested: { label: "Not confirmed", variant: "warning" },
  confirmed: { label: "Booked", variant: "success" },
  checked_in: { label: "Checked in", variant: "secondary" },
  in_progress: { label: "In progress", variant: "secondary" },
  completed: { label: "Completed", variant: "muted" },
  no_show: { label: "No-show", variant: "danger" },
  cancelled: { label: "Cancelled", variant: "muted" },
};

const MESSAGE_STATUS: Record<string, { label: string; variant: "success" | "warning" | "muted" | "danger" }> = {
  simulated: { label: "Sandbox", variant: "muted" },
  queued: { label: "Queued", variant: "warning" },
  sent: { label: "Sent", variant: "success" },
  delivered: { label: "Delivered", variant: "success" },
  failed: { label: "Failed", variant: "danger" },
  suppressed: { label: "Not sent", variant: "muted" },
  held: { label: "Held", variant: "warning" },
};

function statusBadge(entry: HistoryEntry) {
  if (!entry.status) return null;
  if (entry.kind === "visit") {
    const s = VISIT_STATUS[entry.status];
    return s ? <Badge variant={s.variant}>{s.label}</Badge> : null;
  }
  if (entry.kind === "call" && entry.status !== "routine") {
    // The AI's triage judgement, labelled as such.
    return <Badge variant="danger">AI triage: {entry.status === "emergency" ? "Emergency" : "Urgent"}</Badge>;
  }
  if (entry.kind === "message") {
    const s = MESSAGE_STATUS[entry.status];
    return s ? <Badge variant={s.variant}>{s.label}</Badge> : null;
  }
  if (entry.kind === "task") return <Badge variant={entry.status === "done" ? "muted" : "warning"}>{entry.status === "done" ? "Done" : "Open"}</Badge>;
  if (entry.kind === "vaccine" && entry.status === "external") return <Badge variant="muted">Given elsewhere</Badge>;
  return null;
}

function when(entry: HistoryEntry, timezone: string): string {
  if (entry.dateOnly) return formatDate(entry.at.toISOString().slice(0, 10));
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(entry.at);
}

/** Small line chart of the weight history; no chart library needed for one series. */
function WeightTrend({ points }: { points: { measuredOn: string; kg: number }[] }) {
  if (points.length === 0) {
    return <p className="text-small text-muted-foreground">No weights yet. Add one when you complete a visit.</p>;
  }
  const latest = points[points.length - 1]!;
  if (points.length === 1) {
    return (
      <p className="text-small">
        <span className="text-h3 font-semibold tabular-nums">{latest.kg} kg</span>{" "}
        <span className="text-muted-foreground">on {formatDate(latest.measuredOn)}. The trend appears after the next weigh-in.</span>
      </p>
    );
  }
  const w = 320;
  const h = 96;
  const pad = 8;
  const kgs = points.map((p) => p.kg);
  const min = Math.min(...kgs);
  const max = Math.max(...kgs);
  const span = max - min || 1;
  const x = (i: number) => pad + (i * (w - pad * 2)) / (points.length - 1);
  const y = (kg: number) => h - pad - ((kg - min) / span) * (h - pad * 2);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.kg).toFixed(1)}`).join(" ");
  const first = points[0]!;
  const change = Math.round((latest.kg - first.kg) * 100) / 100;
  return (
    <div className="grid gap-2">
      <p className="text-small">
        <span className="text-h3 font-semibold tabular-nums">{latest.kg} kg</span>{" "}
        <span className="text-muted-foreground">
          on {formatDate(latest.measuredOn)} · {change === 0 ? "no change" : `${change > 0 ? "+" : ""}${change} kg`} since {formatDate(first.measuredOn)}
        </span>
      </p>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-24 w-full" role="img" aria-label={`Weight from ${first.kg} kg to ${latest.kg} kg over ${points.length} weigh-ins`}>
        <path d={path} fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => (
          <circle key={`${p.measuredOn}-${i}`} cx={x(i)} cy={y(p.kg)} r="3" fill="var(--card)" stroke="var(--primary)" strokeWidth="2">
            <title>{`${p.kg} kg, ${formatDate(p.measuredOn)}`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 rounded-lg bg-muted/60 px-3 py-2.5">
      <span className="text-h3 font-semibold tabular-nums">{value}</span>
      <span className="text-caption text-muted-foreground">{label}</span>
    </div>
  );
}

export async function PatientHistory({
  clinic,
  locationId,
  timezone,
  patientId,
  petName,
  today,
  permissions,
  filter,
  before,
  canBook,
}: {
  clinic: SqlClient;
  locationId: string;
  timezone: string;
  patientId: string;
  petName: string;
  today: string;
  permissions: ReadonlySet<Permission>;
  filter: string;
  before: string | null;
  canBook: boolean;
}) {
  const filters = historyFiltersFor(permissions);
  const active = filters.find((f) => f.id === filter)?.id ?? "all";
  const kinds = historyKindsFor(permissions, active);
  const [summary, weights, timeline] = await Promise.all([
    patientHealthSummary(clinic, locationId, patientId, today),
    weightHistory(clinic, locationId, patientId),
    patientTimeline(clinic, locationId, patientId, { kinds, before, limit: 30 }),
  ]);
  const overdue = summary.vaccines.filter((v) => v.state === "overdue");
  const dueSoon = summary.vaccines.filter((v) => v.state === "due_soon");
  const href = (q: Record<string, string>) => `/patients/${patientId}?${new URLSearchParams({ tab: "history", ...q }).toString()}`;

  return (
    <div className="grid gap-5">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Panel title="Health overview">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Completed visits" value={summary.visits.completed} />
            <Stat label="Upcoming" value={summary.visits.upcoming} />
            <Stat label="No-shows" value={summary.visits.noShows} />
            <Stat label="Cancelled" value={summary.visits.cancelled} />
          </div>
          <dl className="grid gap-2 text-small sm:grid-cols-2">
            <div className="grid gap-0.5">
              <dt className="text-muted-foreground">Last visit</dt>
              <dd className="font-medium">{summary.lastVisit ? `${summary.lastVisit.service}, ${formatDate(summary.lastVisit.date)}` : "None recorded"}</dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-muted-foreground">Next visit</dt>
              <dd className="font-medium">
                {summary.nextVisit ? (
                  <Link href={`/schedule?date=${summary.nextVisit.date}&visit=${summary.nextVisit.appointmentId}`} className="text-primary hover:underline">
                    {summary.nextVisit.service}, {formatDate(summary.nextVisit.date)}
                  </Link>
                ) : canBook ? (
                  <Link href={`/schedule/book?patient=${patientId}`} className="text-primary hover:underline">
                    Nothing booked. Book a visit
                  </Link>
                ) : (
                  "Nothing booked"
                )}
              </dd>
            </div>
          </dl>
          <div className="grid gap-2">
            <p className="text-small font-medium">Vaccines</p>
            {summary.vaccines.length === 0 ? (
              <p className="text-small text-muted-foreground">No vaccines on record.</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {summary.vaccines.map((v) => (
                  <li key={v.name}>
                    <Badge variant={v.state === "overdue" ? "danger" : v.state === "due_soon" ? "warning" : "success"}>
                      {v.name} · {v.state === "overdue" ? "overdue since" : "due"} {formatDate(v.dueAt)}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
            {(overdue.length > 0 || dueSoon.length > 0) && (
              <p className="text-caption text-muted-foreground">
                {overdue.length > 0 && `${overdue.length} overdue. `}
                {dueSoon.length > 0 && `${dueSoon.length} due in the next 30 days. `}
                Reminders go out automatically.
              </p>
            )}
          </div>
          {summary.prevention.length > 0 && (
            <div className="grid gap-2">
              <p className="text-small font-medium">Parasite prevention</p>
              <ul className="flex flex-wrap gap-1.5">
                {summary.prevention.map((p) => (
                  <li key={p.product}>
                    <Badge variant={p.state === "ended" ? "danger" : p.state === "ending_soon" ? "warning" : "success"}>
                      {p.product} · supply {p.state === "ended" ? "ended" : "until"} {formatDate(p.supplyEndAt)}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>
        <Panel title="Weight">
          <WeightTrend points={weights} />
        </Panel>
      </div>

      <Panel title="Timeline">
        <nav aria-label="Show in timeline" className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
          {filters.map((f) => (
            <Link
              key={f.id}
              href={href(f.id === "all" ? {} : { filter: f.id })}
              scroll={false}
              aria-current={f.id === active ? "page" : undefined}
              className={cn(
                "shrink-0 rounded-full border px-3 py-1.5 text-small font-medium transition-colors",
                f.id === active ? "border-primary bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {f.label}
            </Link>
          ))}
        </nav>
        <p className="text-caption text-muted-foreground">
          Each entry shows where it came from: <strong className="font-medium">Clinic record</strong>, what the <strong className="font-medium">owner said</strong>,
          the <strong className="font-medium">AI</strong>&apos;s judgement, or an <strong className="font-medium">automatic</strong> message. Clinical notes and
          diagnoses stay in your practice software.
        </p>

        {timeline.entries.length === 0 ? (
          <EmptyState
            icon={History}
            title={before ? "Nothing older" : `Nothing here for ${petName} yet`}
            description={before ? "You have reached the start of the history." : "Visits, vaccines, calls and messages appear here as they happen."}
            action={
              before ? (
                <Link href={href(active === "all" ? {} : { filter: active })} className="text-small font-medium text-primary hover:underline">
                  Back to the newest
                </Link>
              ) : undefined
            }
          />
        ) : (
          <ol className="relative grid gap-0 border-l pl-5">
            {timeline.entries.map((e) => {
              const Icon = KIND_ICON[e.kind] ?? Bell;
              const body = (
                <>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-medium">{e.title}</span>
                    {statusBadge(e)}
                  </span>
                  {e.detail && <span className="line-clamp-2 text-small text-muted-foreground">{e.detail}</span>}
                  <span className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
                    <time dateTime={e.at.toISOString()}>{when(e, timezone)}</time>
                    <span className={cn("rounded px-1.5 py-0.5 font-medium", SOURCE_STYLE[e.source])}>{HISTORY_SOURCE_LABEL[e.source]}</span>
                  </span>
                </>
              );
              return (
                <li key={`${e.kind}-${e.id}`} className="relative py-2.5">
                  <span className="absolute -left-[33px] top-3 flex size-6 items-center justify-center rounded-full border bg-card text-primary">
                    <Icon className="size-3.5" aria-hidden />
                  </span>
                  {e.href ? (
                    <Link href={e.href} className="grid gap-1 rounded-md p-2 -m-2 hover:bg-muted">
                      {body}
                    </Link>
                  ) : (
                    <div className="grid gap-1">{body}</div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {timeline.next && (
          <Link
            href={href({ ...(active === "all" ? {} : { filter: active }), before: timeline.next })}
            scroll={false}
            className="justify-self-center rounded-md border px-4 py-2 text-small font-medium hover:bg-muted"
          >
            Show older
          </Link>
        )}
      </Panel>
    </div>
  );
}

/** Shown while the History tab loads. */
export function PatientHistorySkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading history" className="grid animate-pulse gap-5">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="h-56 rounded-xl bg-muted" />
        <div className="h-56 rounded-xl bg-muted" />
      </div>
      <div className="grid gap-2 rounded-xl bg-muted/60 p-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-14 rounded-lg bg-muted" />
        ))}
      </div>
    </div>
  );
}
