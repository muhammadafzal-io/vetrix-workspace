import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Sparkles } from "lucide-react";
import { checkCampaignCopy, describeAudience, SKIP_REASON_LABEL, type CampaignChannel, type CopyIssue, type SkipReason } from "@vetrix/domain";
import { audienceOptions, campaignFacts, campaignResults, forbiddenCampaignTerms, getCampaign, previewAudience } from "@vetrix/db/runtime";
import { Panel } from "@/components/patterns/detail-list";
import { PageHeader } from "@/components/patterns/page-header";
import { Pagination } from "@/components/patterns/pagination";
import { outOfRange, pageUrl, readPaging } from "@/lib/paging";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { assertId, orNotFound, requirePage } from "@/features/clients/access";
import { updateBasicsAction } from "@/features/campaigns/actions";
import { AudienceBuilder } from "@/features/campaigns/audience-builder";
import { BasicsForm } from "@/features/campaigns/basics-form";
import { ContentEditor } from "@/features/campaigns/content-editor";
import { SendPanel } from "@/features/campaigns/send-panel";
import { TestEmailBox } from "@/features/campaigns/test-email";
import { getSession } from "@/lib/session";
import { CampaignStatusBadge } from "@/features/campaigns/status-badge";
import { aiMode } from "@/lib/ai";
import { clinicToday } from "@/lib/clinic-date";
import { getMessagingMode } from "@/lib/env";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Campaign · Vetrix" };

const CHANNEL: Record<CampaignChannel, string> = { sms: "Text", email: "Email" };
const MESSAGE_STATUS: Record<string, string> = { simulated: "Saved (Sandbox)", queued: "Waiting to send", sent: "Sent", delivered: "Delivered", failed: "Failed" };

export default async function CampaignPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ built?: string; rpage?: string; rsize?: string }> }) {
  const shell = await requirePage("campaigns.manage");
  const session = await getSession();
  const id = assertId((await params).id);
  const sp = await searchParams;
  const built = sp.built;
  // The people in the campaign are paged on their own (rpage, rsize), so the rest of the page stays put.
  const recipientPaging = readPaging(sp, { defaultSize: 25, pageParam: "rpage", sizeParam: "rsize" });
  const loc = shell.location.id;
  const c = await orNotFound(getCampaign(shell.clinic, loc, id));
  const [options, facts] = await Promise.all([audienceOptions(shell.clinic, loc), campaignFacts(shell.clinic, loc, c.goal)]);
  const editable = c.status === "draft" || c.status === "approved" || c.status === "scheduled";
  const started = c.status === "sending" || c.status === "sent" || (c.status === "cancelled" && c.sent + c.skipped > 0);
  const sandbox = getMessagingMode() === "sandbox";

  // The latest version of each channel, and what the copy check finds in it.
  const latest = (ch: CampaignChannel) => c.content.find((x) => x.channel === ch);
  const issues: Partial<Record<CampaignChannel, CopyIssue[]>> = {};
  for (const ch of c.channels) {
    const v = latest(ch);
    if (v) issues[ch] = checkCampaignCopy({ channel: ch, subject: v.subject, body: v.body }, facts.facts, forbiddenCampaignTerms());
  }
  const hasAudience = c.audience.conditions.length > 0;
  const ready = !hasAudience
    ? "Choose and save who the campaign goes to (step 2) before approving."
    : c.channels.find((ch) => !latest(ch))
      ? `Write the ${c.channels.find((ch) => !latest(ch)) === "sms" ? "text message" : "email"} (step 3) before approving.`
      : c.channels.some((ch) => (issues[ch]?.length ?? 0) > 0)
        ? "Fix the points flagged in step 3 before approving."
        : null;

  let reach = "";
  if (hasAudience && editable) {
    const p = await previewAudience(shell.clinic, { locationId: loc, audience: c.audience, channels: c.channels, today: clinicToday(shell.location.timezone), now: Date.now(), campaignId: id });
    reach = `Today it would reach ${c.channels.map((ch) => `${p.perChannel[ch]?.send ?? 0} by ${CHANNEL[ch].toLowerCase()}`).join(" and ")} (of ${p.clients} matching clients).`;
  }
  const results = started ? await campaignResults(shell.clinic, loc, id, { limit: recipientPaging.pageSize, offset: recipientPaging.offset }) : null;
  const lastRecipients = results ? outOfRange(recipientPaging.page, results.recipientsTotal, recipientPaging.pageSize) : null;
  if (lastRecipients) redirect(pageUrl(`/campaigns/${id}`, sp, lastRecipients, "rpage"));
  const sendAtText = c.send_at
    ? new Intl.DateTimeFormat("en-US", { timeZone: shell.location.timezone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(c.send_at)
    : null;

  return (
    <>
      <Link href="/campaigns" className="mb-3 inline-flex items-center gap-1.5 text-small font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden /> Campaigns
      </Link>
      <PageHeader title={c.name} description={<span className="flex flex-wrap items-center gap-2"><CampaignStatusBadge status={c.status} />{c.approved_by_name && c.status !== "draft" ? `Approved by ${c.approved_by_name}` : null}</span>} />

      <div className="grid max-w-4xl gap-6">
        {(built === "ai" || built === "sandbox") && c.status === "draft" && (
          <Alert variant="info">
            <Sparkles aria-hidden />
            <div className="grid gap-1">
              <p className="font-medium">{built === "ai" ? "AI set up this campaign from your request." : "Set up from your request (Sandbox: no AI key, audience from keywords)."}</p>
              <p className="text-small">
                Check who it goes to ({describeAudience(c.audience, options.services).replace(/^Clients whose pets match (all|any) of: /, "").toLowerCase()}) and read the text and email. Change anything you like, then approve in step 4. Nothing has been sent.
              </p>
            </div>
          </Alert>
        )}
        {results && (
          <Panel title="Results">
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                [sandbox ? "Saved (Sandbox)" : "Sent", sandbox ? results.simulated : results.sent],
                ["Delivered", results.delivered],
                ["Failed", results.failed + (results.pending ? ` (${results.pending} retrying)` : "")],
                ["Booked within 14 days", results.booked],
                ...(results.waiting ? [["Waiting to send", results.waiting]] : []),
                ["Unsubscribed", results.unsubscribed],
                ...Object.entries(results.skipped).map(([r, n]) => [`Skipped: ${SKIP_REASON_LABEL[r as SkipReason].toLowerCase()}`, n]),
              ].map(([label, value]) => (
                <div key={String(label)} className="grid content-start gap-0.5 rounded-lg bg-muted/40 px-3 py-2.5">
                  <dt className="text-caption text-muted-foreground">{label}</dt>
                  <dd className="text-h3 font-semibold tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            <details id="recipients" className="mt-4 scroll-mt-24 text-small" open={Boolean(sp.rpage || sp.rsize)}>
              <summary className="cursor-pointer font-medium text-primary">Everyone in this campaign ({results.recipientsTotal.toLocaleString("en-US")})</summary>
              <ul className="mt-2 grid">
                {results.recipients.map((r, i) => (
                  <li key={i} className="flex flex-wrap items-center justify-between gap-2 border-t py-1.5">
                    <span>{r.clientName}{r.petNames ? <span className="text-muted-foreground"> · {r.petNames}</span> : null}</span>
                    <span className="flex items-center gap-2 text-caption">
                      <Badge variant="muted">{CHANNEL[r.channel]}</Badge>
                      <span className={cn(r.status === "skipped" || r.messageStatus === "failed" ? "text-muted-foreground" : "")}>
                        {r.skipReason ? SKIP_REASON_LABEL[r.skipReason] : r.status === "pending" ? "Waiting" : (MESSAGE_STATUS[r.messageStatus ?? ""] ?? r.messageStatus)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              <Pagination
                page={recipientPaging.page}
                pageSize={recipientPaging.pageSize}
                defaultSize={25}
                total={results.recipientsTotal}
                basePath={`/campaigns/${id}`}
                params={{}}
                pageParam="rpage"
                sizeParam="rsize"
                anchor="recipients"
                label="Pages of people in this campaign"
                noun="rows"
              />
            </details>
          </Panel>
        )}

        <Panel title="1 · Goal">
          <BasicsForm action={updateBasicsAction.bind(null, id)} saved={{ name: c.name, goal: c.goal, channels: c.channels }} submitLabel="Save" locked={!editable} />
        </Panel>

        <Panel title="2 · Who gets it">
          <AudienceBuilder campaignId={id} saved={c.audience} channels={c.channels} options={options} locked={!editable} />
        </Panel>

        <Panel title="3 · Message">
          <ContentEditor
            campaignId={id}
            channels={c.channels}
            content={c.content}
            issues={issues}
            audienceSummary={describeAudience(c.audience, options.services)}
            clinicName={facts.clinicName}
            clinicPhone={facts.clinicPhone ?? "the clinic"}
            locked={!editable}
            aiLive={aiMode() === "openai"}
          />
        </Panel>

        <Panel title="4 · Approve and send">
          <div className="grid gap-5">
            {c.channels.includes("email") && <TestEmailBox campaignId={id} defaultTo={session?.user.email ?? ""} ready={Boolean(latest("email"))} />}
            <SendPanel campaignId={id} status={c.status} ready={ready} sendAtText={sendAtText} sandbox={sandbox} reach={reach} />
          </div>
        </Panel>
      </div>
    </>
  );
}
