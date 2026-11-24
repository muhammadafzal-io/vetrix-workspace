import type { Metadata } from "next";
import Link from "next/link";
import { BellRing, CheckCircle2, Mail, MessageSquareText, PauseCircle, PhoneCall } from "lucide-react";
import { isQuietHours, localParts, reminderCounts, type Species } from "@vetrix/domain";
import { messagingSettings, previewReminders, remindersPaused, retentionStats, type RetentionStats } from "@vetrix/db/runtime";
import { Panel } from "@/components/patterns/detail-list";
import { Pagination } from "@/components/patterns/pagination";
import { outOfRange, pageUrl, readPaging, slicePage } from "@/lib/paging";
import { redirect } from "next/navigation";
import { EmptyState } from "@/components/patterns/empty-state";
import { PageHeader } from "@/components/patterns/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { requirePage } from "@/features/clients/access";
import { SpeciesIcon } from "@/features/clients/species-icon";
import { RunButton, StopButton } from "@/features/reminders/controls";
import { TestReminderBox } from "@/features/reminders/test-reminder";
import { clinicToday, formatDate } from "@/lib/clinic-date";
import { getMessagingMode } from "@/lib/env";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Reminders · Vetrix" };

/** The pack's test data is dated for this day (docs/test-data/expected-reminders.md). */
const TEST_DATA_DATE = "2026-11-03";
type Rule = { id: string; name: string; touches: { offset_days?: number; offset_hours?: number; channels: string[] }[] };

const plural = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
const when = (offset: number) => (offset < 0 ? `${plural(-offset)} before` : offset === 0 ? "On the day" : `${plural(offset)} after`);
const channelIcon = { sms: MessageSquareText, email: Mail, ai_call: PhoneCall } as const;
const channelLabel: Record<string, string> = { sms: "Text", email: "Email", ai_call: "AI call" };

function dueText(dueIn: number) {
  if (dueIn === 0) return "Due today";
  return dueIn > 0 ? `Due in ${dueIn} day${dueIn === 1 ? "" : "s"}` : `${-dueIn} day${dueIn === -1 ? "" : "s"} overdue`;
}

export default async function RemindersPage({ searchParams }: { searchParams: Promise<{ asOf?: string; rule?: string; show?: string; page?: string; size?: string; rulesPage?: string }> }) {
  const shell = await requirePage("reminders.manage");
  const sp = await searchParams;
  const sandbox = getMessagingMode() === "sandbox";
  const today = clinicToday(shell.location.timezone);
  const asOf = sandbox && sp.asOf && /^\d{4}-\d{2}-\d{2}$/.test(sp.asOf) ? sp.asOf : today;
  const [{ rows, input }, settings, paused, stats] = await Promise.all([
    previewReminders(shell.clinic, shell.location.id, asOf),
    messagingSettings(shell.clinic, shell.location.id),
    remindersPaused(shell.clinic, shell.location.id),
    retentionStats(shell.clinic, shell.location.id, today),
  ]);
  const quiet = isQuietHours(localParts(Date.now(), settings.timezone).minutes, settings.quietStart, settings.quietEnd);
  const counts = reminderCounts(rows);
  // The rules as this clinic runs them (its own schedule where it has one).
  const rules = (input.rules as Rule[]).filter((r) => counts.has(`${r.id}:all`) || rows.some((x) => x.ruleId === r.id));
  const dueNow = rows.filter((r) => r.nextTouch);
  // Two lists, each with its own page in the address: the reminders (page, size) and the rule counts (rulesPage).
  const listPaging = readPaging(sp, { defaultSize: 25 });
  const rulePaging = readPaging(sp, { defaultSize: 10, pageParam: "rulesPage", sizeParam: "rulesSize" });
  const visible = rows.filter((r) => (sp.rule ? r.ruleId === sp.rule : true) && (sp.show === "all" ? true : r.nextTouch || r.suppressed || r.lastSent));
  const lastList = outOfRange(listPaging.page, visible.length, listPaging.pageSize);
  if (lastList) redirect(pageUrl("/reminders", sp, lastList));
  const lastRules = outOfRange(rulePaging.page, rules.length, rulePaging.pageSize);
  if (lastRules) redirect(pageUrl("/reminders", sp, lastRules, "rulesPage"));
  const href = (q: Record<string, string | undefined>) => ({ pathname: "/reminders", query: Object.fromEntries(Object.entries({ asOf: asOf !== today ? asOf : undefined, rule: sp.rule, show: sp.show, ...q }).filter(([, v]) => v)) });

  return (
    <>
      <PageHeader
        title="Reminders"
        description={asOf === today ? "Who is due for what today, and what goes out next." : `As of ${formatDate(asOf)} (test data date). Sandbox only.`}
      />

      {paused && (
        <Alert variant="warning" className="mb-6">
          <PauseCircle aria-hidden />
          <p>
            Reminders are paused, so nothing new goes out.{" "}
            {shell.permissions.has("settings.manage") ? (
              <Link href="/settings#reminders" className="font-medium underline">
                Turn them back on in Settings
              </Link>
            ) : (
              "Ask a practice manager to turn them back on."
            )}
          </p>
        </Alert>
      )}

      <VaccineNumbers stats={stats} sandbox={sandbox} />

      <div className="mb-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Panel title="Today's run">
          <p className="text-small text-muted-foreground">
            {dueNow.length} reminder{dueNow.length === 1 ? " is" : "s are"} due to go out. Pets of the same household due within two weeks get one message. Nothing is sent twice, and suppressed pets get nothing.
          </p>
          {shell.permissions.has("reminders.manage") && <RunButton asOf={asOf} due={dueNow.length} quiet={quiet} paused={paused} />}
          {shell.permissions.has("reminders.manage") && (
            <TestReminderBox
              steps={(input.rules as Rule[]).flatMap((r) =>
                r.touches.map((t, i) => ({
                  value: `${r.id}:${i}`,
                  label: `${r.name} · ${when(t.offset_days ?? Math.floor((t.offset_hours ?? 0) / 24))}`,
                })),
              )}
            />
          )}
          {sandbox && (
            <p className="text-caption text-muted-foreground">
              Sandbox: messages are saved under Messages and not sent.{" "}
              {asOf === today ? (
                <Link className="font-medium text-primary hover:underline" href={href({ asOf: TEST_DATA_DATE })}>
                  Check against the test data date (3 Nov 2026)
                </Link>
              ) : (
                <Link className="font-medium text-primary hover:underline" href={{ pathname: "/reminders" }}>
                  Back to today
                </Link>
              )}
            </p>
          )}
        </Panel>

        <Panel title="Counts by rule">
          <div className="overflow-x-auto">
            <table className="w-full text-small">
              <thead>
                <tr className="text-left text-caption text-muted-foreground">
                  <th className="pb-2 font-medium">Rule</th>
                  <th className="pb-2 font-medium">Touch</th>
                  <th className="pb-2 text-right font-medium">Pets</th>
                </tr>
              </thead>
              <tbody>
                {slicePage(rules, rulePaging).flatMap((r) =>
                  r.touches.map((t, i) => {
                    const off = t.offset_days ?? Math.floor((t.offset_hours ?? 0) / 24);
                    return (
                      <tr key={`${r.id}-${i}`} className="border-t">
                        <td className="py-1.5 pr-3">{i === 0 ? <Link href={href({ rule: r.id })} className="font-medium hover:underline">{r.name}</Link> : null}</td>
                        <td className="py-1.5 pr-3 text-muted-foreground">
                          {when(off)} · {t.channels.map((c) => channelLabel[c]).join(" + ")}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">{counts.get(`${r.id}:${off}`) ?? 0}</td>
                      </tr>
                    );
                  }),
                )}
              </tbody>
            </table>
          </div>
          <Pagination
            page={rulePaging.page}
            pageSize={rulePaging.pageSize}
            defaultSize={10}
            total={rules.length}
            basePath="/reminders"
            params={{ asOf: asOf !== today ? asOf : undefined, rule: sp.rule, show: sp.show, page: sp.page, size: sp.size }}
            pageParam="rulesPage"
            sizeParam="rulesSize"
            showSizes={false}
            label="Rule pages"
            noun="rules"
          />
        </Panel>
      </div>

      <nav className="mb-3 flex flex-wrap gap-2" aria-label="Filter">
        <Link href={href({ rule: undefined })} className={cn("rounded-full border px-3.5 py-1.5 text-small font-medium", !sp.rule ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted")}>
          All rules
        </Link>
        {rules.map((r) => (
          <Link key={r.id} href={href({ rule: r.id })} className={cn("rounded-full border px-3.5 py-1.5 text-small font-medium", sp.rule === r.id ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted")}>
            {r.name}
          </Link>
        ))}
        <Link href={href({ show: sp.show === "all" ? undefined : "all" })} className="ml-auto self-center text-small font-medium text-primary hover:underline">
          {sp.show === "all" ? "Hide not-yet-due" : "Show everything on record"}
        </Link>
      </nav>

      {visible.length === 0 ? (
        <EmptyState icon={BellRing} title="No reminders due" description="When pets are due for a visit, vaccine or refill, they appear here." />
      ) : (
        <ul className="grid gap-2">
          {slicePage(visible, listPaging).map((r) => {
            const t = r.nextTouch;
            return (
              <li key={`${r.ruleId}-${r.patientId}-${r.dueAt}`} className={cn("flex flex-col gap-3 rounded-lg border bg-card p-4 shadow-card sm:flex-row sm:items-center", r.suppressed && "opacity-75")}>
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-secondary text-primary">
                  <SpeciesIcon species={r.species as Species} className="size-5" />
                </span>
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <p className="flex flex-wrap items-center gap-x-2 font-semibold">
                    <Link href={`/patients/${r.patientId}`} className="hover:underline">{r.petName}</Link>
                    <span className="text-small font-normal text-muted-foreground">· {r.clientName}</span>
                  </p>
                  <p className="text-small">
                    {r.ruleName}
                    {r.detail ? <span className="text-muted-foreground"> ({r.detail})</span> : null}
                  </p>
                  <p className={cn("text-caption", r.dueIn < 0 ? "text-warning-text" : "text-muted-foreground")}>
                    {dueText(r.dueIn)} · {formatDate(r.dueAt)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  {r.suppressed ? (
                    <Badge variant="muted">Not sent: {r.suppressed.toLowerCase()}</Badge>
                  ) : t ? (
                    <span className="flex items-center gap-1.5 text-small">
                      Next: {when(t.offsetDays).toLowerCase()} by
                      {t.channels.map((c) => {
                        const Icon = channelIcon[c as keyof typeof channelIcon];
                        return (
                          <Badge key={c} variant="secondary">
                            <Icon className="size-3.5" aria-hidden /> {channelLabel[c]}
                          </Badge>
                        );
                      })}
                    </span>
                  ) : r.lastSent ? (
                    <Badge variant="success">
                      <CheckCircle2 className="size-3.5" aria-hidden /> Sent
                    </Badge>
                  ) : (
                    <Badge variant="muted">Nothing due yet</Badge>
                  )}
                  {!r.suppressed && <StopButton ruleId={r.ruleId} patientId={r.patientId} dueAt={r.dueAt} />}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Pagination
        page={listPaging.page}
        pageSize={listPaging.pageSize}
        defaultSize={25}
        total={visible.length}
        basePath="/reminders"
        params={{ asOf: asOf !== today ? asOf : undefined, rule: sp.rule, show: sp.show, rulesPage: sp.rulesPage }}
        label="Reminder pages"
        noun="reminders"
      />
    </>
  );
}

/** Vaccine reminder results: who is overdue now, and what the last 30 days of reminders achieved. */
function VaccineNumbers({ stats, sandbox }: { stats: RetentionStats; sandbox: boolean }) {
  const pct = stats.conversion === null ? "–" : `${Math.round(stats.conversion * 100)}%`;
  const tiles: { label: string; value: string | number; hint?: string; tone?: "warning" | "danger" }[] = [
    { label: "Overdue 3–6 days", value: stats.overdue3to6, tone: stats.overdue3to6 ? "warning" : undefined },
    { label: "Overdue 7+ days", value: stats.overdue7plus, hint: "Up to 60 days", tone: stats.overdue7plus ? "warning" : undefined },
    sandbox ? { label: "Saved (Sandbox)", value: stats.simulated, hint: "Not sent" } : { label: "Sent", value: stats.sent },
    { label: "Delivered", value: stats.delivered, hint: "Texts with a carrier report" },
    { label: "Failed", value: stats.failed, hint: stats.pending ? `${stats.pending} waiting to retry` : undefined, tone: stats.failed ? "danger" : undefined },
    { label: "Vaccinated after a reminder", value: stats.vaccinated, hint: `of ${stats.reminded} reminded` },
    { label: "Conversion", value: pct, hint: "Vaccinated ÷ reminded" },
  ];
  return (
    <section aria-labelledby="vaccine-numbers" className="mb-6 rounded-xl border bg-card p-5 shadow-card">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="vaccine-numbers" className="text-body font-semibold">Vaccine reminders</h2>
        <p className="text-caption text-muted-foreground">Overdue: today. Messages and results: last 30 days.</p>
      </div>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {tiles.map((t) => (
          <div key={t.label} className="grid content-start gap-0.5 rounded-lg bg-muted/40 px-3 py-2.5">
            <dt className="text-caption text-muted-foreground">{t.label}</dt>
            <dd className={cn("text-h3 font-semibold tabular-nums", t.tone === "warning" && "text-warning-text", t.tone === "danger" && "text-destructive")}>{t.value}</dd>
            {t.hint && <dd className="text-caption text-muted-foreground">{t.hint}</dd>}
          </div>
        ))}
      </dl>
    </section>
  );
}
