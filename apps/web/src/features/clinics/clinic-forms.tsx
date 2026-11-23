"use client";

import { useActionState, useState, useTransition } from "react";
import { Loader2, Mail, Plus, RotateCw } from "lucide-react";
import { slugFromName } from "@vetrix/domain";
import { FormField } from "@/components/patterns/form-field";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { fieldError, SubmitButton } from "@/features/clients/form-bits";
import type { ActionResult } from "@/lib/action-result";
import { addClinicAction, resendInviteAction, retryClinicAction } from "./actions";

export function AddClinicForm({ timezones, defaultTimezone }: { timezones: string[]; defaultTimezone: string }) {
  const [state, action] = useActionState<ActionResult | null, FormData>(addClinicAction, null);
  const v = state && !state.ok ? state.values : undefined;
  const val = (k: string) => (typeof v?.[k] === "string" ? (v[k] as string) : "");
  // The web address follows the clinic name until it is edited by hand.
  const [name, setName] = useState(val("clinicName"));
  const [slug, setSlug] = useState(val("slug"));
  const [slugEdited, setSlugEdited] = useState(Boolean(val("slug")));
  const shownSlug = slugEdited ? slug : slugFromName(name);

  return (
    <form action={action} className="grid gap-4" key={state?.ok ? state.message : "add"}>
      <FormField label="Clinic name" error={fieldError(state, "clinicName")}>
        {(p) => <Input {...p} name="clinicName" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} placeholder="Paws & Claws Veterinary" />}
      </FormField>
      <FormField label="Address in Vetrix" hint="Lowercase letters, numbers and hyphens. Can't be changed later." error={fieldError(state, "slug")}>
        {(p) => (
          <Input
            {...p}
            name="slug"
            autoComplete="off"
            value={shownSlug}
            onChange={(e) => {
              setSlugEdited(true);
              setSlug(e.target.value.toLowerCase());
            }}
            placeholder="paws-and-claws"
          />
        )}
      </FormField>
      <FormField label="First location" hint="Leave empty to use the clinic name." error={fieldError(state, "locationName")}>
        {(p) => <Input {...p} name="locationName" autoComplete="off" defaultValue={val("locationName")} placeholder="Main hospital" />}
      </FormField>
      <FormField label="Time zone" error={fieldError(state, "timezone")}>
        {(p) => (
          <Select {...p} name="timezone" defaultValue={val("timezone") || defaultTimezone}>
            {timezones.map((tz) => (
              <option key={tz} value={tz}>
                {tz.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Owner's name" error={fieldError(state, "ownerName")}>
          {(p) => <Input {...p} name="ownerName" autoComplete="off" defaultValue={val("ownerName")} placeholder="Dana Reyes" />}
        </FormField>
        <FormField label="Owner's email" error={fieldError(state, "ownerEmail")}>
          {(p) => <Input {...p} name="ownerEmail" type="email" autoComplete="off" defaultValue={val("ownerEmail")} placeholder="dana@clinic.com" />}
        </FormField>
      </div>
      {state && !state.ok && !state.field && <Alert variant="error">{state.error}</Alert>}
      {state?.ok && <Alert variant="success">{state.message}</Alert>}
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingText="Creating the clinic… (up to a minute)">
          <Plus aria-hidden /> Add clinic
        </SubmitButton>
        <span className="text-caption text-muted-foreground">Creates a new Neon database. It starts empty: no sample data.</span>
      </div>
    </form>
  );
}

function useButtonAction(run: () => Promise<ActionResult>) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  return { pending, result, go: () => start(async () => setResult(await run())) };
}

export function RetryButton({ tenantId }: { tenantId: string }) {
  const a = useButtonAction(() => retryClinicAction(tenantId));
  return (
    <div className="grid justify-items-start gap-1">
      <Button type="button" size="sm" variant="outline" onClick={a.go} disabled={a.pending}>
        {a.pending ? <Loader2 className="animate-spin" aria-hidden /> : <RotateCw aria-hidden />} {a.pending ? "Retrying…" : "Retry"}
      </Button>
      {a.result && !a.result.ok && <p className="text-caption text-destructive">{a.result.error}</p>}
    </div>
  );
}

export function ResendInviteButton({ tenantId }: { tenantId: string }) {
  const a = useButtonAction(() => resendInviteAction(tenantId));
  return (
    <div className="grid justify-items-start gap-1">
      <Button type="button" size="sm" variant="ghost" onClick={a.go} disabled={a.pending}>
        {a.pending ? <Loader2 className="animate-spin" aria-hidden /> : <Mail aria-hidden />} Resend invite
      </Button>
      {a.result && <p className={a.result.ok ? "text-caption text-muted-foreground" : "text-caption text-destructive"}>{a.result.ok ? a.result.message : a.result.error}</p>}
    </div>
  );
}
