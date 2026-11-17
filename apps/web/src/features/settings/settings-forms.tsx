"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AppWindow,
  BellRing,
  Copy,
  ExternalLink,
  Eye,
  Bot,
  Building2,
  CalendarOff,
  CalendarPlus,
  CheckCircle2,
  Clock,
  Loader2,
  MoonStar,
  ScrollText,
  Stethoscope,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { FormField } from "@/components/patterns/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { fieldError, formDefaults, FormError, SubmitButton } from "@/features/clients/form-bits";
import type { ActionResult } from "@/lib/action-result";
import { cn } from "@/lib/utils";
import {
  addHolidayAction,
  removeHolidayAction,
  saveDetailsAction,
  saveFrontDeskAction,
  saveHoursAction,
  saveMessagingAction,
  savePoliciesAction,
  setReminderRuleAction,
  saveWidgetAction,
  setServiceActiveAction,
  setServiceOnlineAction,
} from "./actions";

type FormAction = (state: ActionResult | null, form: FormData) => Promise<ActionResult>;
type Defaults = ReturnType<typeof formDefaults>;

// ---------- Building blocks ----------

export const SECTIONS: { id: string; label: string; icon: LucideIcon }[] = [
  { id: "details", label: "Clinic", icon: Building2 },
  { id: "hours", label: "Opening hours", icon: Clock },
  { id: "closed-days", label: "Closed days", icon: CalendarOff },
  { id: "front-desk", label: "AI front desk", icon: Bot },
  { id: "policies", label: "Policies", icon: ScrollText },
  { id: "messaging", label: "Quiet hours", icon: MoonStar },
  { id: "reminders", label: "Reminders", icon: BellRing },
  { id: "services", label: "Services", icon: Stethoscope },
  { id: "widget", label: "Booking widget", icon: AppWindow },
];

/** Section list: a sticky side menu on large screens, scrolling chips on small ones. Highlights the section in view. */
export function SettingsNav() {
  const [active, setActive] = useState(SECTIONS[0]!.id);
  useEffect(() => {
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        const first = SECTIONS.find((s) => seen.get(s.id));
        if (first) setActive(first.id);
      },
      { rootMargin: "-80px 0px -55% 0px" },
    );
    for (const s of SECTIONS) {
      const el = document.getElementById(s.id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, []);
  return (
    <nav aria-label="Settings sections" className="lg:sticky lg:top-24 lg:self-start">
      <ul className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:mx-0 lg:grid lg:overflow-visible lg:px-0">
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <li key={id} className="shrink-0">
            <a
              href={`#${id}`}
              aria-current={active === id ? "true" : undefined}
              onClick={() => setActive(id)}
              className={cn(
                "flex items-center gap-2 rounded-full border px-3 py-1.5 text-small font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                "lg:rounded-md lg:border-transparent lg:px-3 lg:py-2",
                active === id && "border-primary/30 bg-primary/10 text-primary hover:bg-primary/10 hover:text-primary",
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              {label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** A settings card: icon, title and description, then its body. */
function Card({ id, title, description, children, footer }: { id: string; title: string; description: string; children: React.ReactNode; footer?: React.ReactNode }) {
  const Icon = SECTIONS.find((x) => x.id === id)?.icon ?? Building2;
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-24 overflow-hidden rounded-xl border bg-card shadow-card">
      <header className="flex items-start gap-3 border-b px-5 py-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-[18px]" aria-hidden />
        </span>
        <div className="grid gap-0.5">
          <h2 id={`${id}-title`} className="text-body font-semibold">
            {title}
          </h2>
          <p className="text-small text-muted-foreground">{description}</p>
        </div>
      </header>
      <div className="grid gap-5 p-5">{children}</div>
      {footer}
    </section>
  );
}

/** A card holding one form, with a Save bar at the bottom. */
function FormCard({
  id,
  title,
  description,
  action,
  fields,
  children,
}: {
  id: string;
  title: string;
  description: string;
  action: FormAction;
  fields: string[];
  children: (d: Defaults, state: ActionResult | null) => React.ReactNode;
}) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(action, null);
  return (
    <form action={formAction}>
      <Card
        id={id}
        title={title}
        description={description}
        footer={
          <div className="flex flex-wrap items-center justify-end gap-3 border-t bg-muted/40 px-5 py-3">
            {state?.ok && (
              <p role="status" className="mr-auto flex items-center gap-1.5 text-small text-success-text">
                <CheckCircle2 className="size-4" aria-hidden /> {state.message}
              </p>
            )}
            <SubmitButton pendingText="Saving…">Save changes</SubmitButton>
          </div>
        }
      >
        {children(formDefaults(state), state)}
        <FormError state={state} fields={fields} />
      </Card>
    </form>
  );
}

/** An input with a fixed unit inside it, like "$" or "hours". */
function UnitInput({ prefix, suffix, className, ...props }: React.ComponentProps<typeof Input> & { prefix?: string; suffix?: string }) {
  return (
    <div className="relative">
      {prefix && <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-small text-muted-foreground">{prefix}</span>}
      <Input {...props} className={cn(prefix && "pl-7", suffix && "pr-16", className)} />
      {suffix && <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-small text-muted-foreground">{suffix}</span>}
    </div>
  );
}

/** An on/off switch (a real checkbox underneath, so forms and screen readers work). */
function Switch({ className, ...props }: Omit<React.ComponentProps<"input">, "type">) {
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      <input type="checkbox" role="switch" className="peer absolute inset-0 z-10 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed" {...props} />
      <span
        aria-hidden
        className="h-6 w-11 rounded-full bg-muted-foreground/30 transition-colors peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-disabled:opacity-50"
      />
      <span aria-hidden className="pointer-events-none absolute left-0.5 top-0.5 size-5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5" />
    </span>
  );
}

// ---------- Clinic details ----------

export interface DetailsValues {
  name: string;
  address: string | null;
  mainPhone: string | null;
  website: string | null;
  timezone: string;
}

export function DetailsForm({ saved, timezones }: { saved: DetailsValues; timezones: string[] }) {
  return (
    <FormCard
      id="details"
      title="Clinic details"
      description="Riley says the clinic name on every call. The time zone sets appointment times, reminders and quiet hours."
      action={saveDetailsAction}
      fields={["name", "address", "mainPhone", "website", "timezone"]}
    >
      {(d, state) => (
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <FormField label="Clinic name" error={fieldError(state, "name")}>
            {(p) => <Input {...p} name="name" defaultValue={d.text("name", saved.name)} />}
          </FormField>
          <FormField label="Main phone" error={fieldError(state, "mainPhone")}>
            {(p) => <Input {...p} name="mainPhone" type="tel" placeholder="(555) 010-1000" defaultValue={d.text("mainPhone", saved.mainPhone)} />}
          </FormField>
          <FormField label="Address" error={fieldError(state, "address")} className="sm:col-span-2">
            {(p) => <Input {...p} name="address" defaultValue={d.text("address", saved.address)} />}
          </FormField>
          <FormField label="Website" error={fieldError(state, "website")}>
            {(p) => <Input {...p} name="website" type="url" placeholder="https://" defaultValue={d.text("website", saved.website)} />}
          </FormField>
          <FormField label="Time zone" error={fieldError(state, "timezone")} hint="Changing this moves how every time is shown.">
            {(p) => (
              <Select {...p} name="timezone" defaultValue={String(d.text("timezone", saved.timezone))}>
                {timezones.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz.replace(/_/g, " ")}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        </div>
      )}
    </FormCard>
  );
}

// ---------- Opening hours ----------

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// Monday first, as clinics read their week.
const ORDER = [1, 2, 3, 4, 5, 6, 0];

export function HoursForm({ saved }: { saved: ({ opens: string; closes: string } | null)[] }) {
  return (
    <FormCard
      id="hours"
      title="Opening hours"
      description="Riley offers times only inside these hours. Outside them, emergencies follow the after-hours setting."
      action={saveHoursAction}
      fields={[]}
    >
      {(d, state) => (
        <ul className="divide-y rounded-lg border">
          {ORDER.map((day) => (
            <HoursRow key={day} day={day} saved={saved[day] ?? null} d={d} error={fieldError(state, `opens_${day}`) ?? fieldError(state, `closes_${day}`)} />
          ))}
        </ul>
      )}
    </FormCard>
  );
}

function HoursRow({ day, saved, d, error }: { day: number; saved: { opens: string; closes: string } | null; d: Defaults; error?: string }) {
  const [open, setOpen] = useState(d.submitted ? !d.on(`closed_${day}`, false) : saved !== null);
  return (
    <li className="grid gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex w-36 cursor-pointer items-center gap-3">
          <Switch checked={open} onChange={(e) => setOpen(e.currentTarget.checked)} aria-label={`${DAYS[day]} open`} />
          <span className="text-small font-medium">{DAYS[day]}</span>
        </label>
        {!open && <input type="hidden" name={`closed_${day}`} value="on" />}
        {/* Times stay in the form while closed, so switching back keeps them. */}
        <div className={cn("flex items-center gap-2", !open && "hidden")}>
          <Input
            type="time"
            name={`opens_${day}`}
            aria-label={`${DAYS[day]} opens`}
            aria-invalid={error ? true : undefined}
            defaultValue={String(d.text(`opens_${day}`, saved?.opens ?? "08:00"))}
            className="h-9 w-32"
          />
          <span className="text-small text-muted-foreground">to</span>
          <Input
            type="time"
            name={`closes_${day}`}
            aria-label={`${DAYS[day]} closes`}
            aria-invalid={error ? true : undefined}
            defaultValue={String(d.text(`closes_${day}`, saved?.closes ?? "18:00"))}
            className="h-9 w-32"
          />
        </div>
        {!open && <span className="text-small text-muted-foreground">Closed</span>}
      </div>
      {error && <p className="text-small text-destructive">{error}</p>}
    </li>
  );
}

// ---------- Closed days ----------

export function HolidaysPanel({ holidays }: { holidays: { id: string; date: string; name: string | null }[] }) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(addHolidayAction, null);
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = holidays.filter((h) => h.date >= today);
  const past = holidays.length - upcoming.length;
  return (
    <Card id="closed-days" title="Closed days" description="Holidays and other days the clinic is shut. Riley won't offer times on them.">
      {upcoming.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-small text-muted-foreground">No closed days coming up.</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {upcoming.map((h) => (
            <HolidayRow key={h.id} holiday={h} />
          ))}
        </ul>
      )}
      {past > 0 && <p className="text-caption text-muted-foreground">{past} past closed {past === 1 ? "day is" : "days are"} kept for the record.</p>}
      <form action={formAction} className="grid gap-3 rounded-lg bg-muted/40 p-4" key={state?.ok ? state.message : "add"}>
        <p className="text-small font-medium">Add a closed day</p>
        <div className="grid gap-3 sm:grid-cols-[11rem_minmax(0,1fr)_auto] sm:items-start">
          <FormField label="Date" error={fieldError(state, "date")}>
            {(p) => <Input {...p} name="date" type="date" min={today} />}
          </FormField>
          <FormField label="Name (optional)" error={fieldError(state, "name")}>
            {(p) => <Input {...p} name="name" placeholder="Thanksgiving" />}
          </FormField>
          <div className="sm:pt-7">
            <SubmitButton pendingText="Adding…">
              <CalendarPlus aria-hidden /> Add
            </SubmitButton>
          </div>
        </div>
        <FormError state={state} fields={["date", "name"]} />
        {state?.ok && (
          <p role="status" className="flex items-center gap-1.5 text-small text-success-text">
            <CheckCircle2 className="size-4" aria-hidden /> {state.message}
          </p>
        )}
      </form>
    </Card>
  );
}

function HolidayRow({ holiday }: { holiday: { id: string; date: string; name: string | null } }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const at = new Date(`${holiday.date}T12:00:00Z`);
  const fmt = (o: Intl.DateTimeFormatOptions) => at.toLocaleDateString("en-US", { ...o, timeZone: "UTC" });
  return (
    <li className="flex items-center gap-3 rounded-lg border px-3 py-2">
      <span className="flex size-11 shrink-0 flex-col items-center justify-center rounded-md bg-secondary text-secondary-foreground">
        <span className="text-[10px] font-semibold uppercase leading-none">{fmt({ month: "short" })}</span>
        <span className="text-body font-semibold leading-tight">{fmt({ day: "numeric" })}</span>
      </span>
      <span className="grid min-w-0 flex-1">
        <span className="truncate text-small font-medium">{holiday.name ?? "Closed"}</span>
        <span className="text-caption text-muted-foreground">{`${fmt({ weekday: "long" })}, ${fmt({ year: "numeric" })}`}</span>
        {error && <span className="text-caption text-destructive">{error}</span>}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={pending}
        aria-label={`Remove ${fmt({ month: "long", day: "numeric", year: "numeric" })}`}
        onClick={() =>
          start(async () => {
            const r = await removeHolidayAction(holiday.id);
            setError(r.ok ? null : r.error);
          })
        }
      >
        {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Trash2 aria-hidden />}
      </Button>
    </li>
  );
}

// ---------- Front desk ----------

export interface FrontDeskValues {
  aiName: string;
  emergencyTransferNumber: string | null;
  afterHoursBehaviour: "er_only" | "er_and_book_next";
  erName: string | null;
  erPhone: string | null;
  erAddress: string | null;
}

const AFTER_HOURS = [
  { value: "er_and_book_next", title: "Emergency hospital, then book", hint: "Give the emergency hospital's details, then offer the next open time." },
  { value: "er_only", title: "Emergency hospital only", hint: "Give the emergency hospital's details and end the call." },
] as const;

export function FrontDeskForm({ saved }: { saved: FrontDeskValues }) {
  const fields = ["aiName", "emergencyTransferNumber", "afterHoursBehaviour", "erName", "erPhone", "erAddress"];
  return (
    <FormCard id="front-desk" title="AI front desk" description="How Riley introduces itself and where emergencies go." action={saveFrontDeskAction} fields={fields}>
      {(d, state) => {
        const behaviour = String(d.text("afterHoursBehaviour", saved.afterHoursBehaviour));
        return (
          <>
            <div className="grid items-start gap-4 sm:grid-cols-2">
              <FormField label="Assistant's name" error={fieldError(state, "aiName")} hint="Said in the greeting and texts.">
                {(p) => <Input {...p} name="aiName" defaultValue={d.text("aiName", saved.aiName)} className="sm:max-w-56" />}
              </FormField>
              <FormField label="Emergency transfer number" error={fieldError(state, "emergencyTransferNumber")} hint="During open hours, emergency calls go straight here.">
                {(p) => <Input {...p} name="emergencyTransferNumber" type="tel" placeholder="(555) 010-1001" defaultValue={d.text("emergencyTransferNumber", saved.emergencyTransferNumber)} />}
              </FormField>
            </div>

            <fieldset className="grid gap-2">
              <legend className="mb-2 text-small font-medium">After hours</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {AFTER_HOURS.map((o) => (
                  <label
                    key={o.value}
                    className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50 has-[:checked]:border-primary has-[:checked]:bg-primary/5"
                  >
                    <input type="radio" name="afterHoursBehaviour" value={o.value} defaultChecked={behaviour === o.value} className="mt-0.5 size-4 accent-[var(--primary)]" />
                    <span className="grid gap-0.5">
                      <span className="text-small font-medium">{o.title}</span>
                      <span className="text-caption text-muted-foreground">{o.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
              {fieldError(state, "afterHoursBehaviour") && <p className="text-small text-destructive">{fieldError(state, "afterHoursBehaviour")}</p>}
            </fieldset>

            <fieldset className="grid gap-4 rounded-lg bg-muted/40 p-4">
              <legend className="sr-only">Emergency hospital</legend>
              <div className="grid gap-0.5">
                <p className="text-small font-medium">Emergency hospital</p>
                <p className="text-caption text-muted-foreground">Where Riley sends emergencies when the clinic is closed. Give all three, or leave all empty.</p>
              </div>
              <div className="grid items-start gap-4 sm:grid-cols-2">
                <FormField label="Name" error={fieldError(state, "erName")}>
                  {(p) => <Input {...p} name="erName" defaultValue={d.text("erName", saved.erName)} />}
                </FormField>
                <FormField label="Phone" error={fieldError(state, "erPhone")}>
                  {(p) => <Input {...p} name="erPhone" type="tel" defaultValue={d.text("erPhone", saved.erPhone)} />}
                </FormField>
                <FormField label="Address" error={fieldError(state, "erAddress")} className="sm:col-span-2">
                  {(p) => <Input {...p} name="erAddress" defaultValue={d.text("erAddress", saved.erAddress)} />}
                </FormField>
              </div>
            </fieldset>
          </>
        );
      }}
    </FormCard>
  );
}

// ---------- Policies ----------

export interface PolicyValues {
  cancellationWindowHours: number;
  cancellationFee: number | null;
  surgeryDeposit: number | null;
  refillTurnaround: string | null;
  newClientPolicy: string | null;
  recordsReleasePolicy: string | null;
  recordingRetentionMonths: number;
  telehealthEnabled: boolean;
}

export function PoliciesForm({ saved }: { saved: PolicyValues }) {
  const fields = ["cancellationWindowHours", "cancellationFee", "surgeryDeposit", "refillTurnaround", "newClientPolicy", "recordsReleasePolicy", "recordingRetentionMonths"];
  return (
    <FormCard id="policies" title="Policies" description="What Riley tells clients about cancelling, fees, refills and records." action={savePoliciesAction} fields={fields}>
      {(d, state) => (
        <>
          <div className="grid items-start gap-4 sm:grid-cols-3">
            <FormField label="Cancellation notice" error={fieldError(state, "cancellationWindowHours")}>
              {(p) => <UnitInput {...p} suffix="hours" name="cancellationWindowHours" type="number" min={0} max={168} defaultValue={d.text("cancellationWindowHours", saved.cancellationWindowHours)} />}
            </FormField>
            <FormField label="Late cancellation fee" error={fieldError(state, "cancellationFee")} hint="Empty means no fee.">
              {(p) => <UnitInput {...p} prefix="$" name="cancellationFee" inputMode="decimal" placeholder="0.00" defaultValue={d.text("cancellationFee", saved.cancellationFee?.toFixed(2))} />}
            </FormField>
            <FormField label="Surgery deposit" error={fieldError(state, "surgeryDeposit")} hint="Empty means no deposit.">
              {(p) => <UnitInput {...p} prefix="$" name="surgeryDeposit" inputMode="decimal" placeholder="0.00" defaultValue={d.text("surgeryDeposit", saved.surgeryDeposit?.toFixed(2))} />}
            </FormField>
            <FormField label="Refill turnaround" error={fieldError(state, "refillTurnaround")} hint='For example "24 hours".'>
              {(p) => <Input {...p} name="refillTurnaround" defaultValue={d.text("refillTurnaround", saved.refillTurnaround)} />}
            </FormField>
            <FormField label="Keep call recordings" error={fieldError(state, "recordingRetentionMonths")}>
              {(p) => <UnitInput {...p} suffix="months" name="recordingRetentionMonths" type="number" min={1} max={120} defaultValue={d.text("recordingRetentionMonths", saved.recordingRetentionMonths)} />}
            </FormField>
            <div className="grid gap-2">
              <span className="text-small font-medium">Telehealth</span>
              <label className="flex h-10 cursor-pointer items-center gap-3">
                <Switch name="telehealthEnabled" defaultChecked={d.on("telehealthEnabled", saved.telehealthEnabled)} />
                <span className="text-small">Offers telehealth visits</span>
              </label>
            </div>
          </div>
          <div className="grid items-start gap-4 sm:grid-cols-2">
            <FormField label="New clients" error={fieldError(state, "newClientPolicy")}>
              {(p) => <Textarea {...p} name="newClientPolicy" rows={3} defaultValue={d.text("newClientPolicy", saved.newClientPolicy)} />}
            </FormField>
            <FormField label="Medical records" error={fieldError(state, "recordsReleasePolicy")}>
              {(p) => <Textarea {...p} name="recordsReleasePolicy" rows={3} defaultValue={d.text("recordsReleasePolicy", saved.recordsReleasePolicy)} />}
            </FormField>
          </div>
        </>
      )}
    </FormCard>
  );
}

// ---------- Messaging ----------

export function MessagingForm({ saved, timezone }: { saved: { quietStart: string; quietEnd: string }; timezone: string }) {
  return (
    <FormCard
      id="messaging"
      title="Quiet hours"
      description="No reminder or staff texts go out in this window. Replies to a client who just texted still go out."
      action={saveMessagingAction}
      fields={["quietStart", "quietEnd"]}
    >
      {(d, state) => (
        <div className="flex flex-wrap items-start gap-4">
          <FormField label="From" error={fieldError(state, "quietStart")}>
            {(p) => <Input {...p} name="quietStart" type="time" className="w-36" defaultValue={d.text("quietStart", saved.quietStart)} />}
          </FormField>
          <FormField label="Until" error={fieldError(state, "quietEnd")}>
            {(p) => <Input {...p} name="quietEnd" type="time" className="w-36" defaultValue={d.text("quietEnd", saved.quietEnd)} />}
          </FormField>
          <p className="self-end pb-2.5 text-small text-muted-foreground">Clinic time ({timezone.replace(/_/g, " ")})</p>
        </div>
      )}
    </FormCard>
  );
}

// ---------- Reminders and services ----------

export function RemindersCard({ rules }: { rules: { id: string; name: string; enabled: boolean; running: boolean }[] }) {
  return (
    <Card id="reminders" title="Reminders" description="Which reminders go out. Turning one off stops new texts for it; reminders already sent stay in the log.">
      <ul className="grid gap-2 sm:grid-cols-2">
        {rules.map((r) => (
          <ToggleRow key={r.id} kind="reminder" id={r.id} label={r.name} detail={r.running ? undefined : "Coming in a later update"} on={r.enabled} disabled={!r.running} />
        ))}
      </ul>
    </Card>
  );
}

type ServiceRow = { id: string; name: string; durationMin: number; active: boolean; bookableOnline: boolean; canBookOnline: boolean };

export function ServicesCard({ groups }: { groups: { label: string; services: ServiceRow[] }[] }) {
  return (
    <Card
      id="services"
      title="Services"
      description="Offered: turn off a service the clinic doesn't do (Riley and staff can't book it). Online: clients can book it themselves in the booking widget. Surgery, euthanasia and sick visits always go through Riley or the team."
    >
      {groups.map((g) => (
        <div key={g.label} className="grid gap-2">
          <h3 className="flex items-center justify-between text-caption font-semibold uppercase tracking-wide text-muted-foreground">
            {g.label}
            <span className="font-normal normal-case tracking-normal">
              {g.services.filter((s) => s.active).length} of {g.services.length} on
            </span>
          </h3>
          <ul className="grid gap-2 sm:grid-cols-2">
            {g.services.map((x) => (
              <ServiceToggles key={x.id} service={x} />
            ))}
          </ul>
        </div>
      ))}
    </Card>
  );
}

function ServiceToggles({ service: x }: { service: ServiceRow }) {
  const [active, setActive] = useState(x.active);
  const [online, setOnline] = useState(x.bookableOnline);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const flip = (which: "active" | "online", next: boolean) => {
    const set = which === "active" ? setActive : setOnline;
    set(next);
    start(async () => {
      const r = which === "active" ? await setServiceActiveAction(x.id, next) : await setServiceOnlineAction(x.id, next);
      if (!r.ok) {
        set(!next);
        setError(r.error);
      } else setError(null);
    });
  };
  return (
    <li className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="truncate text-small font-medium">{x.name}</span>
        <span className="text-caption text-muted-foreground">{[x.durationMin ? `${x.durationMin} min` : null, !x.canBookOnline ? "Not online" : null].filter(Boolean).join(" · ")}</span>
        {error && <span className="text-caption text-destructive">{error}</span>}
      </span>
      {pending && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />}
      <span className="grid justify-items-center gap-1">
        <span className="text-[11px] leading-none text-muted-foreground" aria-hidden>
          Offered
        </span>
        <Switch aria-label={`${x.name}: offered`} checked={active} disabled={pending} onChange={(e) => flip("active", e.currentTarget.checked)} />
      </span>
      <span className="grid justify-items-center gap-1">
        <span className="text-[11px] leading-none text-muted-foreground" aria-hidden>
          Online
        </span>
        <Switch
          aria-label={`${x.name}: clients can book online`}
          checked={online && active}
          disabled={pending || !active || !x.canBookOnline}
          onChange={(e) => flip("online", e.currentTarget.checked)}
        />
      </span>
    </li>
  );
}

// ---------- Booking widget ----------

/** The live widget in a pop-up, as on a clinic's website. Its close button works too. */
function WidgetPreview({ url, disabled }: { url: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const origin = new URL(url, window.location.href).origin;
    const onMessage = (e: MessageEvent) => {
      if (e.origin === origin && (e.data as { type?: string } | null)?.type === "booking-widget:close") setOpen(false);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [open, url]);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled}>
          <Eye aria-hidden /> Preview
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-navy-900/55 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 h-[min(720px,calc(100dvh-3rem))] w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl bg-card shadow-2xl focus:outline-none">
          <Dialog.Title className="sr-only">Booking widget preview</Dialog.Title>
          <Dialog.Description className="sr-only">The booking widget as clients see it on your website.</Dialog.Description>
          {/* A new frame each time, so the preview always starts at the beginning. */}
          <iframe src={url} title="Booking widget preview" className="size-full border-0" />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function WidgetForm({ saved, hostedUrl, scriptUrl, slug }: { saved: { enabled: boolean; origins: string[] }; hostedUrl: string; scriptUrl: string; slug: string }) {
  const snippet = `<script src="${scriptUrl}" data-clinic="${slug}" async></script>`;
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (what: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    });
  };
  return (
    <FormCard
      id="widget"
      title="Booking widget"
      description="A “Book a visit” button for your website. Clients confirm their mobile with a texted code, then book a routine visit, chat with Riley, or call."
      action={saveWidgetAction}
      fields={["origins"]}
    >
      {(d, state) => (
        <>
          <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border px-4 py-3 hover:bg-muted/50">
            <span className="grid gap-0.5">
              <span className="text-small font-medium">Online booking is on</span>
              <span className="text-caption text-muted-foreground">Off: the button and link say to call instead.</span>
            </span>
            <Switch name="enabled" defaultChecked={d.on("enabled", saved.enabled)} aria-label="Online booking is on" />
          </label>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/50 px-4 py-3">
            <span className="grid gap-0.5">
              <span className="text-small font-medium">See it as clients do</span>
              <span className="text-caption text-muted-foreground">
                {saved.enabled ? "The live widget with your saved settings. Bookings made in it are real." : "Turn online booking on and save to try it."}
              </span>
            </span>
            <WidgetPreview url={`${hostedUrl}?embed=1`} disabled={!saved.enabled} />
          </div>
          <FormField label="Your websites" hint="One per line, e.g. happypawsvet.com. Only these sites can show the widget." error={fieldError(state, "origins")}>
            {(p) => (
              <Textarea {...p} name="origins" rows={3} className="max-w-xl font-mono text-small" defaultValue={d.text("origins", saved.origins.join("\n"))} placeholder="happypawsvet.com" />
            )}
          </FormField>
          <div className="grid gap-2">
            <p className="text-small font-medium">Add to your website</p>
            <p className="text-caption text-muted-foreground">Paste this before the closing &lt;/body&gt; tag. Any link with data-booking-widget also opens it.</p>
            <div className="flex max-w-2xl items-start gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-md border bg-muted/50 px-3 py-2 font-mono text-caption">{snippet}</code>
              <Button type="button" variant="outline" size="sm" onClick={() => copy("code", snippet)}>
                <Copy aria-hidden /> {copied === "code" ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
          <div className="grid gap-2">
            <p className="text-small font-medium">Booking link</p>
            <p className="text-caption text-muted-foreground">For Google Business Profile, Facebook, Instagram and emails.</p>
            <div className="flex max-w-2xl flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/50 px-3 py-2 font-mono text-caption">{hostedUrl}</code>
              <Button type="button" variant="outline" size="sm" onClick={() => copy("link", hostedUrl)}>
                <Copy aria-hidden /> {copied === "link" ? "Copied" : "Copy"}
              </Button>
              <a href={hostedUrl} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-sm px-3 text-small font-medium text-primary hover:bg-muted">
                <ExternalLink className="size-4" aria-hidden /> Open
              </a>
            </div>
          </div>
        </>
      )}
    </FormCard>
  );
}

function ToggleRow({ kind, id, label, detail, on, disabled }: { kind: "reminder" | "service"; id: string; label: string; detail?: string; on: boolean; disabled?: boolean }) {
  const [checked, setChecked] = useState(on);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <li>
      <label className={cn("flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors", disabled ? "cursor-not-allowed bg-muted/40" : "cursor-pointer hover:bg-muted/50")}>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className={cn("truncate text-small font-medium", disabled && "text-muted-foreground")}>{label}</span>
          {detail && <span className="text-caption text-muted-foreground">{detail}</span>}
          {error && <span className="text-caption text-destructive">{error}</span>}
        </span>
        {pending && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />}
        <Switch
          aria-label={label}
          checked={checked}
          disabled={disabled || pending}
          onChange={(e) => {
            const next = e.currentTarget.checked;
            setChecked(next);
            start(async () => {
              const r = kind === "reminder" ? await setReminderRuleAction(id, next) : await setServiceActiveAction(id, next);
              if (!r.ok) {
                setChecked(!next);
                setError(r.error);
              } else setError(null);
            });
          }}
        />
      </label>
    </li>
  );
}
