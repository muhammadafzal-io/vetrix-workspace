"use client";

// "Send a test email": the campaign's latest email, sent for real to the
// addresses typed here, marked [TEST]. The box starts with the signed-in
// person's email and remembers what was typed last (this browser only).
import { useEffect, useState, useTransition } from "react";
import { AlertCircle, CheckCircle2, Loader2, MailCheck } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ActionResult } from "@/lib/action-result";
import { sendTestEmailAction } from "./actions";

const KEY = "vetrix.campaignTestTo";

export function TestEmailBox({ campaignId, defaultTo, ready }: { campaignId: string; defaultTo: string; ready: boolean }) {
  const [to, setTo] = useState(defaultTo);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(KEY);
      if (saved) setTo(saved);
    } catch {
      // Private mode or storage blocked: keep the default.
    }
  }, []);

  const send = () =>
    start(async () => {
      try {
        window.localStorage.setItem(KEY, to);
      } catch {
        // Not saved; the send still goes ahead.
      }
      setResult(await sendTestEmailAction(campaignId, to));
    });

  return (
    <div className="grid gap-2.5 rounded-lg border border-dashed p-4">
      <p className="flex items-center gap-2 text-small font-semibold">
        <MailCheck className="size-4 text-primary" aria-hidden /> Send a test email
      </p>
      <p className="text-caption text-muted-foreground">
        The latest email, sent for real and marked [TEST], with sample names (Sam; Bella and Max). It never counts toward the results or the 7-day limit. Up to 5 addresses, separated by commas.
      </p>
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <label htmlFor="campaign-test-to" className="sr-only">
          Test email addresses
        </label>
        <Input id="campaign-test-to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@clinic.com" autoComplete="email" inputMode="email" className="flex-1" />
        <Button type="submit" variant="outline" disabled={pending || !ready || !to.trim()}>
          {pending ? <Loader2 className="animate-spin" aria-hidden /> : <MailCheck aria-hidden />} Send test
        </Button>
      </form>
      {!ready && <p className="text-caption text-muted-foreground">Write the email first (step 3).</p>}
      {result && (
        <Alert variant={result.ok ? "success" : "error"}>
          {result.ok ? <CheckCircle2 aria-hidden /> : <AlertCircle aria-hidden />}
          <p>{result.ok ? result.message : result.error}</p>
        </Alert>
      )}
    </div>
  );
}
