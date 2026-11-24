"use client";

// "Send a test reminder": any reminder step, as this clinic runs it, sent for
// real to the addresses typed (marked [TEST], sample pet). Works at any time,
// whether or not a pet is due. Remembers the addresses in this browser.
import { useEffect, useState, useTransition } from "react";
import { AlertCircle, CheckCircle2, Loader2, MailCheck } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { sendTestReminderAction } from "./actions";

const KEY = "vetrix.reminderTestTo";

export function TestReminderBox({ steps }: { steps: { value: string; label: string }[] }) {
  const [step, setStep] = useState(steps[0]?.value ?? "");
  const [to, setTo] = useState("");
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(KEY) ?? window.localStorage.getItem("vetrix.campaignTestTo");
      if (saved) setTo(saved);
    } catch {
      // Storage blocked: start empty.
    }
  }, []);

  if (steps.length === 0) return null;
  return (
    <form
      className="grid gap-2.5 rounded-lg border border-dashed p-4"
      onSubmit={(e) => {
        e.preventDefault();
        try {
          window.localStorage.setItem(KEY, to);
        } catch {
          // Not saved; still sends.
        }
        start(async () => {
          const r = await sendTestReminderAction(step, to);
          setResult(r.ok ? { ok: true, text: r.message } : { ok: false, text: r.error });
        });
      }}
    >
      <p className="flex items-center gap-2 text-small font-semibold">
        <MailCheck className="size-4 text-primary" aria-hidden /> Send a test reminder
      </p>
      <p className="text-caption text-muted-foreground">
        Any reminder, as your clinic sends it, by email right now, marked [TEST] with a sample pet (Bella). It doesn&apos;t need a pet to be due and never counts as a real reminder.
      </p>
      <label className="grid gap-1 text-caption font-medium">
        Reminder
        <Select value={step} onChange={(e) => setStep(e.currentTarget.value)}>
          {steps.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="reminder-test-to" className="sr-only">
          Test email addresses
        </label>
        <Input id="reminder-test-to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@clinic.com" autoComplete="email" inputMode="email" className="flex-1" />
        <Button type="submit" variant="outline" disabled={pending || !to.trim() || !step}>
          {pending ? <Loader2 className="animate-spin" aria-hidden /> : <MailCheck aria-hidden />} Send test
        </Button>
      </div>
      {result && (
        <Alert variant={result.ok ? "success" : "error"}>
          {result.ok ? <CheckCircle2 aria-hidden /> : <AlertCircle aria-hidden />}
          <p>{result.text}</p>
        </Alert>
      )}
    </form>
  );
}
