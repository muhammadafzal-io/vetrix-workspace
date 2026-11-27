"use client";

// Forms on the visit record page. They only collect input: every rule
// (who may write, edit window, doctor-only prescriber, real image type, size)
// is checked again on the server in @vetrix/domain.
import { useActionState, useEffect, useState, useTransition } from "react";
import { CheckCircle2, ImagePlus, Loader2, Pencil, Sparkles, Trash2, Wand2, X } from "lucide-react";
import { PRESCRIPTION_ROUTE_LABEL, PRESCRIPTION_ROUTES, VISIT_AI_MAX_INPUT, VISIT_PHOTO_LIMITS, VISIT_RECORD_LIMITS, type ParsedPrescription } from "@vetrix/domain";
import { FormField } from "@/components/patterns/form-field";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/action-result";
import { cn } from "@/lib/utils";
import { fieldError, FormError, SubmitButton } from "@/features/clients/form-bits";

type Action = (state: ActionResult | null, form: FormData) => Promise<ActionResult>;
type AiDraft<T> = { ok: true; draft: T; source: "ai" | "sandbox" } | { ok: false; error: string };
export type TidyFn = (kind: string, text: string) => Promise<AiDraft<string>>;
export type ReadRxFn = (text: string) => Promise<AiDraft<ParsedPrescription>>;

function valueOf(state: ActionResult | null, key: string): string | undefined {
  if (!state || state.ok || !state.values) return undefined;
  const v = state.values[key];
  return Array.isArray(v) ? v[0] : v;
}

function Saved({ state }: { state: ActionResult | null }) {
  if (!state?.ok) return null;
  return (
    <Alert variant="success">
      <CheckCircle2 aria-hidden />
      <p>{state.message ?? "Saved."}</p>
    </Alert>
  );
}

// ---------- Notes and recommendations ----------

export function EntryForm({ action, today, tidy }: { action: Action; today: string; tidy?: TidyFn }) {
  const [state, formAction] = useActionState(action, null);
  const [kind, setKind] = useState(valueOf(state, "kind") ?? "note");
  return (
    <form key={JSON.stringify(state)} action={formAction} className="grid gap-3">
      <Saved state={state} />
      <FormError state={state} fields={["body", "followUpOn", "kind"]} />
      <fieldset className="flex flex-wrap gap-2">
        <legend className="sr-only">Type</legend>
        {(["note", "recommendation"] as const).map((k) => (
          <label key={k} className={cn("flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-small font-medium", kind === k && "border-primary bg-primary/5 text-primary")}>
            <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} className="size-4 accent-[var(--primary)]" />
            {k === "note" ? "Note" : "Recommendation"}
          </label>
        ))}
      </fieldset>
      <FormField label={kind === "note" ? "Note" : "Recommendation"} error={fieldError(state, "body")}>
        {(f) => (
          <TidyableText
            field={f}
            kind={kind}
            tidy={tidy}
            defaultValue={valueOf(state, "body") ?? ""}
            placeholder={kind === "note" ? "What you saw, what you did. Shorthand is fine." : "What the owner should do at home, when to come back"}
          />
        )}
      </FormField>
      {kind === "recommendation" && (
        <FormField label="Follow-up date (optional)" hint="For example a recheck in two weeks." error={fieldError(state, "followUpOn")} className="max-w-56">
          {(f) => <Input {...f} type="date" name="followUpOn" min={today} defaultValue={valueOf(state, "followUpOn")} />}
        </FormField>
      )}
      <div>
        <SubmitButton pendingText="Saving…">Save {kind === "note" ? "note" : "recommendation"}</SubmitButton>
      </div>
    </form>
  );
}

/**
 * The note's text box with "Tidy with AI": the AI's version is shown beside
 * the staff's own text, and replaces it only when they choose "Use this".
 * Nothing is saved until they press Save.
 */
function TidyableText({
  field,
  kind,
  tidy,
  defaultValue,
  placeholder,
}: {
  field: { id: string; "aria-describedby"?: string; "aria-invalid"?: true };
  kind: string;
  tidy?: TidyFn;
  defaultValue: string;
  placeholder?: string;
}) {
  const [value, setValue] = useState(defaultValue);
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [used, setUsed] = useState(false);
  const [busy, start] = useTransition();
  const ask = () =>
    start(async () => {
      setProblem(null);
      const r = await tidy!(kind, value);
      if (r.ok) setDraft(r.draft);
      else setProblem(r.error);
    });
  return (
    <div className="grid gap-2">
      <Textarea
        {...field}
        name="body"
        required
        maxLength={VISIT_RECORD_LIMITS.entryChars}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        className="min-h-28"
      />
      <input type="hidden" name="aiAssisted" value={used ? "1" : ""} />
      {tidy && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy || !value.trim() || value.length > VISIT_AI_MAX_INPUT} onClick={ask}>
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />} Tidy with AI
          </Button>
          <span className="text-caption text-muted-foreground">Rewords your text only. It never adds findings, medicines or doses.</span>
        </div>
      )}
      {problem && <p className="text-caption text-destructive">{problem}</p>}
      {draft && (
        <div className="grid gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
          <p className="flex items-center gap-1.5 text-caption font-semibold text-primary">
            <Sparkles className="size-3.5" aria-hidden /> AI draft: check it before you save
          </p>
          <p className="whitespace-pre-line text-small">{draft}</p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setValue(draft);
                setUsed(true);
                setDraft(null);
              }}
            >
              Use this
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)}>
              Keep mine
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function EntryEdit({ action, body, followUpOn, isRecommendation, tidy }: { action: Action; body: string; followUpOn: string | null; isRecommendation: boolean; tidy?: TidyFn }) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(action, null);
  useEffect(() => {
    if (state?.ok) setOpen(false);
  }, [state]);
  if (!open) {
    return (
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <Pencil aria-hidden /> Edit
      </Button>
    );
  }
  return (
    <form key={JSON.stringify(state)} action={formAction} className="grid w-full gap-3">
      <FormError state={state} fields={["body", "followUpOn"]} />
      <FormField label="Edit" error={fieldError(state, "body")}>
        {(f) => <TidyableText field={f} kind={isRecommendation ? "recommendation" : "note"} tidy={tidy} defaultValue={valueOf(state, "body") ?? body} />}
      </FormField>
      {isRecommendation && (
        <FormField label="Follow-up date (optional)" error={fieldError(state, "followUpOn")} className="max-w-56">
          {(f) => <Input {...f} type="date" name="followUpOn" defaultValue={valueOf(state, "followUpOn") ?? followUpOn ?? ""} />}
        </FormField>
      )}
      <div className="flex gap-2">
        <SubmitButton pendingText="Saving…">Save changes</SubmitButton>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ---------- Remove (void) ----------

export function RemoveRecord({ action, what }: { action: Action; what: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(action, null);
  if (!open) {
    return (
      <Button type="button" variant="ghost" size="sm" className="justify-self-start text-destructive hover:text-destructive" onClick={() => setOpen(true)}>
        <Trash2 aria-hidden /> Remove
      </Button>
    );
  }
  return (
    <form action={formAction} className="grid w-full gap-2 rounded-md border border-destructive/30 bg-danger-soft p-3">
      <FormError state={state} fields={["reason"]} />
      <FormField label={`Why is this ${what} being removed?`} hint="It is hidden, not deleted: the record history keeps it with your reason." error={fieldError(state, "reason")}>
        {(f) => <Input {...f} name="reason" required minLength={3} maxLength={VISIT_RECORD_LIMITS.voidReasonChars} placeholder="For example: added to the wrong pet" autoFocus />}
      </FormField>
      <div className="flex gap-2">
        <SubmitButton pendingText="Removing…">Remove</SubmitButton>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          <X aria-hidden /> Cancel
        </Button>
      </div>
    </form>
  );
}

// ---------- Prescriptions ----------

export function PrescriptionForm({
  action,
  doctors,
  defaultDoctor,
  readRx,
}: {
  action: Action;
  doctors: { id: string; name: string }[];
  defaultDoctor: string | null;
  readRx?: ReadRxFn;
}) {
  const [state, formAction] = useActionState(action, null);
  // Fields filled from the quick-entry line; the fields remount (version) to show them.
  const [prefill, setPrefill] = useState<{ fields: ParsedPrescription; source: "ai" | "sandbox" } | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (state?.ok) setPrefill(null);
  }, [state]);
  const v = (k: string) => valueOf(state, k) ?? ((prefill?.fields[k as keyof ParsedPrescription] || undefined) as string | undefined);
  if (doctors.length === 0) {
    return <p className="text-small text-muted-foreground">Add a doctor in Settings → Team before recording prescriptions.</p>;
  }
  return (
    <form key={JSON.stringify(state)} action={formAction} className="grid gap-4">
      <Saved state={state} />
      <FormError state={state} fields={["drugName", "strength", "dose", "route", "frequency", "durationDays", "quantity", "refills", "instructions", "prescribedBy"]} />
      {readRx && (
        <QuickRxEntry
          readRx={readRx}
          onRead={(r) => {
            setPrefill(r);
            setVersion((n) => n + 1);
          }}
        />
      )}
      {prefill && (
        <p className="flex items-center gap-1.5 rounded-md bg-primary/5 px-3 py-2 text-caption font-medium text-primary">
          <Wand2 className="size-3.5" aria-hidden />
          {prefill.source === "ai" ? "Filled in by AI" : "Filled in by Sandbox rules"} from your line. Check every field before you save; empty ones were not in the line.
        </p>
      )}
      <input type="hidden" name="aiAssisted" value={prefill ? "1" : ""} />
      <div key={version} className="grid gap-4 sm:grid-cols-2">
        <FormField label="Medicine" error={fieldError(state, "drugName")}>
          {(f) => <Input {...f} name="drugName" required maxLength={200} defaultValue={v("drugName")} placeholder="Carprofen" />}
        </FormField>
        <FormField label="Strength (optional)" error={fieldError(state, "strength")}>
          {(f) => <Input {...f} name="strength" maxLength={100} defaultValue={v("strength")} placeholder="75 mg" />}
        </FormField>
        <FormField label="Dose" error={fieldError(state, "dose")}>
          {(f) => <Input {...f} name="dose" required maxLength={200} defaultValue={v("dose")} placeholder="1 tablet" />}
        </FormField>
        <FormField label="How often" error={fieldError(state, "frequency")}>
          {(f) => <Input {...f} name="frequency" required maxLength={200} defaultValue={v("frequency")} placeholder="Twice a day with food" />}
        </FormField>
        <FormField label="Given (optional)" error={fieldError(state, "route")}>
          {(f) => (
            <Select {...f} name="route" defaultValue={v("route") ?? ""}>
              <option value="">Not stated</option>
              {PRESCRIPTION_ROUTES.map((r) => (
                <option key={r} value={r}>
                  {PRESCRIPTION_ROUTE_LABEL[r]}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="Days (optional)" error={fieldError(state, "durationDays")}>
          {(f) => <Input {...f} name="durationDays" inputMode="numeric" defaultValue={v("durationDays")} placeholder="7" />}
        </FormField>
        <FormField label="Quantity (optional)" error={fieldError(state, "quantity")}>
          {(f) => <Input {...f} name="quantity" maxLength={100} defaultValue={v("quantity")} placeholder="14 tablets" />}
        </FormField>
        <FormField label="Refills" error={fieldError(state, "refills")}>
          {(f) => <Input {...f} name="refills" inputMode="numeric" defaultValue={v("refills") ?? "0"} />}
        </FormField>
      </div>
      <FormField label="Instructions for the owner (optional)" error={fieldError(state, "instructions")}>
        {(f) => <Textarea {...f} name="instructions" maxLength={2000} defaultValue={v("instructions")} className="min-h-20" />}
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2 sm:items-end">
        <FormField label="Prescribed by" error={fieldError(state, "prescribedBy")}>
          {(f) => (
            <Select {...f} name="prescribedBy" required defaultValue={v("prescribedBy") ?? defaultDoctor ?? ""}>
              <option value="" disabled>
                Choose the doctor…
              </option>
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <CheckboxField name="controlled" label="Controlled substance" defaultChecked={v("controlled") === "on"} />
      </div>
      <div>
        <SubmitButton pendingText="Saving…">Save prescription</SubmitButton>
      </div>
    </form>
  );
}

/** One line of shorthand ("carprofen 75mg 1 tab bid x7d #14") read into the fields below. */
function QuickRxEntry({ readRx, onRead }: { readRx: ReadRxFn; onRead: (r: { fields: ParsedPrescription; source: "ai" | "sandbox" }) => void }) {
  const [line, setLine] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const read = () =>
    start(async () => {
      setProblem(null);
      const r = await readRx(line);
      if (r.ok) onRead({ fields: r.draft, source: r.source });
      else setProblem(r.error);
    });
  return (
    <div className="grid gap-2 rounded-lg border border-dashed p-3">
      <label htmlFor="rx-quick" className="flex items-center gap-1.5 text-small font-medium">
        <Wand2 className="size-4 text-primary" aria-hidden /> Quick entry (optional)
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="rx-quick"
          value={line}
          maxLength={VISIT_AI_MAX_INPUT}
          onChange={(e) => setLine(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (line.trim()) read();
            }
          }}
          placeholder="carprofen 75mg 1 tab po bid x7d #14"
          autoComplete="off"
        />
        <Button type="button" variant="outline" disabled={busy || !line.trim()} onClick={read} className="shrink-0">
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Wand2 aria-hidden />} Fill in fields
        </Button>
      </div>
      <p className="text-caption text-muted-foreground">It only copies what you typed into the fields. It never picks a medicine or a dose.</p>
      {problem && <p className="text-caption text-destructive">{problem}</p>}
    </div>
  );
}

// ---------- Photos ----------

export function PhotoUpload({ action }: { action: Action }) {
  const [state, formAction] = useActionState(action, null);
  const [preview, setPreview] = useState<string | null>(null);
  const [tooBig, setTooBig] = useState(false);
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);
  useEffect(() => {
    if (state?.ok) setPreview(null);
  }, [state]);

  return (
    <form key={JSON.stringify(state)} action={formAction} className="grid gap-4">
      <Saved state={state} />
      <FormError state={state} fields={["photo", "bodyArea", "caption"]} />
      <FormField
        label="Photo"
        hint={tooBig ? undefined : "JPEG, PNG or WebP, up to 10 MB. Location data from phones is removed."}
        error={tooBig ? "This photo is over 10 MB." : fieldError(state, "photo")}
      >
        {(f) => (
          <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
            <label
              htmlFor={f.id}
              className="flex size-28 cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-dashed bg-muted/50 text-muted-foreground hover:bg-muted"
            >
              {preview ? (
                // eslint-disable-next-line @next/next/no-img-element -- a local preview (blob: URL), not a remote image
                <img src={preview} alt="Chosen photo" className="size-full object-cover" />
              ) : (
                <ImagePlus className="size-7" aria-hidden />
              )}
            </label>
            <input
              {...f}
              type="file"
              name="photo"
              required
              accept="image/jpeg,image/png,image/webp"
              capture="environment"
              className="text-small file:mr-3 file:rounded-md file:border file:bg-card file:px-3 file:py-1.5 file:text-small file:font-medium"
              onChange={(e) => {
                const file = e.target.files?.[0];
                setTooBig(Boolean(file && file.size > VISIT_PHOTO_LIMITS.maxUploadBytes));
                setPreview(file ? URL.createObjectURL(file) : null);
              }}
            />
          </div>
        )}
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Body area (optional)" error={fieldError(state, "bodyArea")}>
          {(f) => <Input {...f} name="bodyArea" maxLength={100} defaultValue={valueOf(state, "bodyArea")} placeholder="Left front paw" />}
        </FormField>
        <FormField label="Caption (optional)" error={fieldError(state, "caption")}>
          {(f) => <Input {...f} name="caption" maxLength={500} defaultValue={valueOf(state, "caption")} placeholder="Swelling between the toes" />}
        </FormField>
      </div>
      <div>
        <SubmitButton pendingText="Uploading…">
          <ImagePlus aria-hidden /> Upload photo
        </SubmitButton>
      </div>
    </form>
  );
}
