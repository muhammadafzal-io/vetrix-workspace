"use client";

// Step 3: the text and the email. "Write with AI" saves a new AI version;
// staff edit and save their own version. Each save runs the copy check
// (facts must come from the goal or clinic details, no promises), and only a
// clean latest version can be approved.
import { useState, useTransition } from "react";
import { AlertCircle, CheckCircle2, Loader2, Mail, MessageSquareText, Sparkles } from "lucide-react";
import { CAMPAIGN_PLACEHOLDERS, CAMPAIGN_SMS_MAX, SMS_OPT_OUT, type CampaignChannel, type CampaignKind, type CopyIssue } from "@vetrix/domain";
import type { CampaignContent } from "@vetrix/db/runtime";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { generateDraftAction, saveContentAction } from "./actions";

const SAMPLE: Record<string, string> = {
  client_first_name: "Sam",
  pet_names: "Bella and Max",
  clinic_name: "",
  clinic_phone: "",
  booking_link: "(booking link)",
};

function fill(text: string, clinicName: string, clinicPhone: string) {
  const v: Record<string, string> = { ...SAMPLE, clinic_name: clinicName, clinic_phone: clinicPhone };
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k: string) => v[k] ?? `{{${k}}}`);
}

function Issues({ issues }: { issues: CopyIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <Alert variant="warning">
      <AlertCircle aria-hidden />
      <div className="grid gap-1">
        <p className="font-medium">Fix before approving:</p>
        <ul className="list-disc pl-4">
          {issues.map((i) => <li key={i.text}>{i.text}</li>)}
        </ul>
      </div>
    </Alert>
  );
}

function ChannelEditor({
  campaignId,
  channel,
  latest,
  issues: initialIssues,
  clinicName,
  clinicPhone,
  locked,
  marketing,
}: {
  campaignId: string;
  marketing: boolean;
  channel: CampaignChannel;
  latest: CampaignContent | undefined;
  issues: CopyIssue[];
  clinicName: string;
  clinicPhone: string;
  locked: boolean;
}) {
  const [subject, setSubject] = useState(latest?.subject ?? "");
  const [body, setBody] = useState(latest?.body ?? "");
  const [issues, setIssues] = useState<CopyIssue[]>(initialIssues);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const dirty = body !== (latest?.body ?? "") || (channel === "email" && subject !== (latest?.subject ?? ""));
  const smsLimit = CAMPAIGN_SMS_MAX - SMS_OPT_OUT.length - 1;
  const Icon = channel === "sms" ? MessageSquareText : Mail;

  return (
    <div className="grid gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-small font-semibold">
          <Icon className="size-4 text-primary" aria-hidden /> {channel === "sms" ? "Text message" : "Email"}
        </p>
        {latest && (
          <Badge variant={latest.approved ? "success" : "muted"}>
            Version {latest.version} · {latest.source === "ai" ? "written by AI" : "edited by staff"}{latest.approved ? " · approved" : ""}
          </Badge>
        )}
      </div>
      {channel === "email" && (
        <label className="grid gap-1 text-caption font-medium">
          Subject
          <Input value={subject} maxLength={150} disabled={locked} onChange={(e) => { setSubject(e.currentTarget.value); setStatus(null); }} />
        </label>
      )}
      <label className="grid gap-1 text-caption font-medium">
        {channel === "sms" ? "Text" : "Email text"}
        <Textarea rows={channel === "sms" ? 4 : 9} value={body} disabled={locked} onChange={(e) => { setBody(e.currentTarget.value); setStatus(null); }} />
      </label>
      {channel === "sms" && (
        <p className={body.length > smsLimit ? "text-caption text-destructive" : "text-caption text-muted-foreground"}>
          {body.length} / {smsLimit} characters. &ldquo;{SMS_OPT_OUT}&rdquo; is added at the end.
        </p>
      )}
      {body && (
        <div className="grid gap-1 rounded-md bg-muted/40 px-3 py-2">
          <p className="text-caption font-medium text-muted-foreground">What a client sees (sample)</p>
          {channel === "email" && <p className="text-small font-medium">{fill(subject, clinicName, clinicPhone)}</p>}
          <p className="whitespace-pre-line text-small">{fill(body, clinicName, clinicPhone)}{channel === "sms" ? ` ${SMS_OPT_OUT}` : marketing ? "\n\n--\nStop these emails: (unsubscribe link)" : ""}</p>
        </div>
      )}
      <Issues issues={issues} />
      {status && (
        <Alert variant={status.ok ? "success" : "error"}>
          {status.ok ? <CheckCircle2 aria-hidden /> : <AlertCircle aria-hidden />}
          <p>{status.text}</p>
        </Alert>
      )}
      {!locked && (
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending || !dirty || !body.trim()}
            onClick={() => start(async () => {
              const r = await saveContentAction(campaignId, channel, channel === "email" ? subject : null, body);
              if (r.ok) {
                setIssues(r.issues);
                setStatus({ ok: true, text: r.issues.length ? "Saved as a new version. Fix the points above before approving." : "Saved as a new version." });
              } else setStatus({ ok: false, text: r.error });
            })}
          >
            {pending && <Loader2 className="animate-spin" aria-hidden />} Save my edits
          </Button>
        </div>
      )}
    </div>
  );
}

export function ContentEditor({
  campaignId,
  channels,
  kind,
  content,
  issues,
  audienceSummary,
  clinicName,
  clinicPhone,
  locked,
  aiLive,
}: {
  campaignId: string;
  channels: CampaignChannel[];
  kind: CampaignKind;
  content: CampaignContent[];
  issues: Partial<Record<CampaignChannel, CopyIssue[]>>;
  audienceSummary: string;
  clinicName: string;
  clinicPhone: string;
  locked: boolean;
  aiLive: boolean;
}) {
  const [pending, start] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  // Remount the editors after a new AI draft so they show it.
  const [round, setRound] = useState(0);
  const latest = (ch: CampaignChannel) => content.find((c) => c.channel === ch);

  return (
    <div className="grid gap-4">
      {!locked && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            disabled={pending}
            onClick={() => start(async () => {
              const r = await generateDraftAction(campaignId, audienceSummary);
              if (r.ok) {
                const n = r.issues.sms.length + r.issues.email.length;
                setNote({ ok: true, text: `${r.source === "ai" ? "AI draft ready" : "Sandbox draft ready (no AI key set)"}. ${n ? "Some points need fixing before approval." : "Review it, edit if you like, then approve."}` });
                setRound((x) => x + 1);
              } else setNote({ ok: false, text: r.error });
            })}
          >
            {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />}
            {pending ? "Writing…" : content.length ? "Write again with AI" : "Write with AI"}
          </Button>
          <p className="text-caption text-muted-foreground">
            {aiLive ? "Uses only your goal and clinic details; any price, date or link it adds that isn't there is flagged." : "Sandbox: no AI key is set, so a plain draft is built from your goal."}
          </p>
        </div>
      )}
      {note && (
        <Alert variant={note.ok ? "success" : "error"}>
          {note.ok ? <CheckCircle2 aria-hidden /> : <AlertCircle aria-hidden />}
          <p>{note.text}</p>
        </Alert>
      )}
      <p className="text-caption text-muted-foreground">
        Placeholders filled for each client: {CAMPAIGN_PLACEHOLDERS.map((p) => `{{${p}}}`).join(", ")}.
      </p>
      {channels.map((ch) => (
        <ChannelEditor
          key={`${ch}-${round}-${latest(ch)?.version ?? 0}`}
          campaignId={campaignId}
          channel={ch}
          latest={latest(ch)}
          issues={issues[ch] ?? []}
          clinicName={clinicName}
          clinicPhone={clinicPhone}
          locked={locked}
          marketing={kind === "marketing"}
        />
      ))}
    </div>
  );
}
