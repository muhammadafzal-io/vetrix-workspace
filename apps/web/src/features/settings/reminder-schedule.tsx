"use client";

// Settings → Reminders: one reminder's schedule (when each message goes out,
// how, and which message). The rules (at most 4, days, channels, messages)
// are checked again in @vetrix/domain when it is saved.
import { useState, useTransition } from "react";
import { AlertCircle, CheckCircle2, Loader2, Plus, Trash2 } from "lucide-react";
import { REMINDER_SCHEDULE_LIMITS, type ReminderChannel, type ScheduleTouch } from "@vetrix/domain";
import type { ReminderScheduleView } from "@vetrix/db/runtime";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { saveReminderScheduleAction } from "./actions";

const CHANNELS: { id: ReminderChannel; label: string }[] = [
  { id: "sms", label: "Text" },
  { id: "email", label: "Email" },
  { id: "ai_call", label: "AI call" },
];

/** Plain names for the pack's messages; anything else shows its key. */
const MESSAGE_LABEL: Record<string, string> = {
  vaccine_due_30: "Due next month",
  vaccine_due_7: "Due next week",
  vaccine_overdue_3: "Now overdue",
  vaccine_overdue_7: "Over a week overdue",
  vaccine_overdue_call: "Overdue (AI call script)",
};

/** The message as an owner would read it, with sample values. */
function preview(text: string, clinicName: string, aiName: string): string {
  const sample: Record<string, string> = {
    clinic_name: clinicName,
    ai_name: aiName,
    pet_name: "Bella",
    client_first_name: "Sam",
    vaccine_names: "Rabies and DAPP",
    booking_link: "(booking link)",
    slot_1: "Tuesday at 10 AM",
    slot_2: "Thursday at 3 PM",
  };
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => sample[k] ?? "…");
}

type Row = { key: number; days: string; when: "before" | "on" | "after"; channels: ReminderChannel[]; template: string };

const toRows = (touches: ScheduleTouch[]): Row[] =>
  touches.map((t, i) => ({
    key: i,
    days: String(Math.abs(t.offset_days)),
    when: t.offset_days < 0 ? "before" : t.offset_days === 0 ? "on" : "after",
    channels: t.channels,
    template: t.template,
  }));

const toTouches = (rows: Row[]) =>
  rows.map((r) => ({ offset_days: r.when === "on" ? 0 : (r.when === "before" ? -1 : 1) * Number(r.days), channels: r.channels, template: r.template }));

function describe(t: ScheduleTouch): string {
  const d = Math.abs(t.offset_days);
  const when = t.offset_days === 0 ? "On the due date" : `${d} day${d === 1 ? "" : "s"} ${t.offset_days < 0 ? "before" : "overdue"}`;
  return `${when} · ${t.channels.map((c) => CHANNELS.find((x) => x.id === c)?.label).join(" + ")}`;
}

export function ReminderScheduleEditor({ schedule, clinicName, aiName }: { schedule: ReminderScheduleView; clinicName: string; aiName: string }) {
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<Row[]>(() => toRows(schedule.touches));
  const [nextKey, setNextKey] = useState(schedule.touches.length);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const text = new Map(schedule.templates.map((t) => [t.key, t.text]));

  const update = (key: number, change: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...change } : r)));
  const submit = (touches: ReturnType<typeof toTouches> | null) =>
    start(async () => {
      const r = await saveReminderScheduleAction(schedule.ruleId, touches);
      setResult(r.ok ? { ok: true, text: r.message ?? "Saved." } : { ok: false, text: r.error });
      if (r.ok) setEditing(false);
    });

  return (
    <div className="grid gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="grid gap-0.5">
          <p className="text-small font-semibold">{schedule.name}: when owners hear from you</p>
          <p className="text-caption text-muted-foreground">Overdue reminders stop 60 days after the due date. Booking a visit stops them sooner.</p>
        </div>
        <Badge variant={schedule.custom ? "success" : "muted"}>{schedule.custom ? "Your schedule" : "Standard schedule"}</Badge>
      </div>

      {result && !editing && (
        <Alert variant={result.ok ? "success" : "error"}>
          {result.ok ? <CheckCircle2 aria-hidden /> : <AlertCircle aria-hidden />}
          <p>{result.text}</p>
        </Alert>
      )}

      {!editing ? (
        <>
          <ol className="grid gap-1.5">
            {schedule.touches.map((t, i) => (
              <li key={i} className="grid gap-0.5 rounded-md bg-muted/40 px-3 py-2">
                <span className="text-small font-medium">{describe(t)}</span>
                <span className="text-caption text-muted-foreground">{MESSAGE_LABEL[t.template] ?? t.template}</span>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap justify-end gap-2">
            {schedule.custom && (
              <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => submit(null)}>
                Use the standard schedule
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setRows(toRows(schedule.touches));
                setResult(null);
                setEditing(true);
              }}
            >
              Change schedule
            </Button>
          </div>
        </>
      ) : (
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit(toTouches(rows));
          }}
        >
          {rows.map((r, i) => (
            <fieldset key={r.key} className="grid gap-3 rounded-md border bg-muted/30 p-3">
              <legend className="sr-only">Reminder {i + 1}</legend>
              <div className="flex flex-wrap items-end gap-2">
                {r.when !== "on" && (
                  <label className="grid w-24 gap-1 text-caption font-medium">
                    Days
                    <Input type="number" min={1} max={r.when === "before" ? -REMINDER_SCHEDULE_LIMITS.minOffsetDays : REMINDER_SCHEDULE_LIMITS.maxOffsetDays} required value={r.days} onChange={(e) => update(r.key, { days: e.currentTarget.value })} />
                  </label>
                )}
                <label className="grid min-w-40 flex-1 gap-1 text-caption font-medium">
                  When
                  <Select value={r.when} onChange={(e) => update(r.key, { when: e.currentTarget.value as Row["when"] })}>
                    <option value="before">before the due date</option>
                    <option value="on">on the due date</option>
                    <option value="after">after the due date (overdue)</option>
                  </Select>
                </label>
                <Button type="button" variant="ghost" size="sm" aria-label={`Remove reminder ${i + 1}`} disabled={rows.length === 1} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                  <Trash2 aria-hidden />
                </Button>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-2" role="group" aria-label="Send by">
                {CHANNELS.map((c) => (
                  <label key={c.id} className="flex cursor-pointer items-center gap-2 text-small">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--primary)]"
                      checked={r.channels.includes(c.id)}
                      onChange={(e) => {
                        const on = e.currentTarget.checked;
                        update(r.key, { channels: on ? [...r.channels, c.id] : r.channels.filter((x) => x !== c.id) });
                      }}
                    />
                    {c.label}
                  </label>
                ))}
              </div>
              {r.channels.includes("ai_call") && (
                <p className="text-caption text-muted-foreground">AI reminder calls start once the voice service is live. Until then, add a text or email as well.</p>
              )}
              <label className="grid gap-1 text-caption font-medium">
                Message
                <Select value={r.template} onChange={(e) => update(r.key, { template: e.currentTarget.value })}>
                  {schedule.templates.map((t) => (
                    <option key={t.key} value={t.key}>
                      {MESSAGE_LABEL[t.key] ?? t.key}
                    </option>
                  ))}
                </Select>
              </label>
              <p className="rounded-md bg-card px-3 py-2 text-caption text-muted-foreground">{preview(text.get(r.template) ?? "", clinicName, aiName)}</p>
            </fieldset>
          ))}
          {/* Next to the Save button, so a refused schedule is seen where it was saved. */}
          {result && !result.ok && (
            <Alert variant="error">
              <AlertCircle aria-hidden />
              <p>{result.text}</p>
            </Alert>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={rows.length >= REMINDER_SCHEDULE_LIMITS.maxTouches}
              onClick={() => {
                setRows((rs) => [...rs, { key: nextKey, days: "3", when: "after", channels: ["sms"], template: schedule.templates.find((t) => t.key.includes("overdue"))?.key ?? schedule.templates[0]!.key }]);
                setNextKey((k) => k + 1);
              }}
            >
              <Plus aria-hidden /> Add reminder
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={pending}>
                {pending && <Loader2 className="animate-spin" aria-hidden />} Save schedule
              </Button>
            </div>
          </div>
          <p className="text-caption text-muted-foreground">Up to {REMINDER_SCHEDULE_LIMITS.maxTouches} reminders. Each goes out once; if one is missed, a later one replaces it.</p>
        </form>
      )}
    </div>
  );
}
