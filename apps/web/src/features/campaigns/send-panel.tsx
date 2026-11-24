"use client";

// Step 4: approve, then send now or at a time; stop or go back to draft.
// What each status allows comes from canChangeCampaign in @vetrix/domain.
import { useState, useTransition } from "react";
import { AlertCircle, CalendarClock, CheckCircle2, Loader2, Send, ShieldCheck, Undo2, XCircle } from "lucide-react";
import { canChangeCampaign, type CampaignStatus } from "@vetrix/domain";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ActionResult } from "@/lib/action-result";
import { approveAction, cancelAction, reopenAction, scheduleAction } from "./actions";

export function SendPanel({
  campaignId,
  status,
  ready,
  sendAtText,
  sandbox,
  reach,
}: {
  campaignId: string;
  status: CampaignStatus;
  /** Why it cannot be approved yet, or null when it can. */
  ready: string | null;
  sendAtText: string | null;
  sandbox: boolean;
  reach: string;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [when, setWhen] = useState("");
  const run = (fn: () => Promise<ActionResult>) => start(async () => setResult(await fn()));

  return (
    <div className="grid gap-3">
      {status === "draft" && (
        <>
          <p className="text-small text-muted-foreground">
            {ready ?? `Approve to send the current text and email. Any later edit sends it back to draft. ${reach}`}
          </p>
          <div>
            <Button type="button" disabled={pending || Boolean(ready)} onClick={() => run(() => approveAction(campaignId))}>
              {pending ? <Loader2 className="animate-spin" aria-hidden /> : <ShieldCheck aria-hidden />} Approve campaign
            </Button>
          </div>
        </>
      )}

      {status === "approved" && (
        <>
          <p className="text-small text-muted-foreground">
            Approved. {reach} {sandbox ? "Sandbox: messages are saved under Messages and not sent." : ""}
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <Button type="button" disabled={pending} onClick={() => run(() => scheduleAction(campaignId, "now"))}>
              {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />} Send now
            </Button>
            <span className="px-1 pb-2.5 text-caption text-muted-foreground">or</span>
            <label className="grid gap-1 text-caption font-medium">
              Send at (clinic time)
              <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.currentTarget.value)} className="w-56" />
            </label>
            <Button type="button" variant="outline" disabled={pending || !when} onClick={() => run(() => scheduleAction(campaignId, when))}>
              <CalendarClock aria-hidden /> Schedule
            </Button>
          </div>
          <p className="text-caption text-muted-foreground">Texts never go out in quiet hours; they wait until the morning. Up to 200 messages go out each minute.</p>
        </>
      )}

      {status === "scheduled" && <p className="text-small">Goes out {sendAtText}. Texts wait for the end of quiet hours.</p>}
      {status === "sending" && <p className="text-small">Sending now, in batches each minute. Refresh to see progress.</p>}
      {status === "sent" && <p className="text-small">Finished. See the results below.</p>}
      {status === "cancelled" && <p className="text-small">Stopped. Nothing more will be sent; messages already sent stay in Messages.</p>}

      {(canChangeCampaign(status, "draft") && status !== "draft") || canChangeCampaign(status, "cancelled") ? (
        <div className="flex flex-wrap gap-2">
          {canChangeCampaign(status, "draft") && status !== "draft" && (
            <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => run(() => reopenAction(campaignId))}>
              <Undo2 aria-hidden /> Back to draft
            </Button>
          )}
          {canChangeCampaign(status, "cancelled") && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => {
                if (window.confirm(status === "sending" ? "Stop sending? Clients not reached yet will not get it." : "Cancel this campaign? It cannot be sent afterwards.")) run(() => cancelAction(campaignId));
              }}
            >
              <XCircle aria-hidden /> {status === "sending" ? "Stop sending" : "Cancel campaign"}
            </Button>
          )}
        </div>
      ) : null}

      {result && (
        <Alert variant={result.ok ? "success" : "error"}>
          {result.ok ? <CheckCircle2 aria-hidden /> : <AlertCircle aria-hidden />}
          <p>{result.ok ? result.message : result.error}</p>
        </Alert>
      )}
    </div>
  );
}
