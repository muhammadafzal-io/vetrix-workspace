"use client";

// Step 1: name, goal and channels. The goal is what the AI writes from, and
// the only source of prices, discounts and dates the message may state.
import { useActionState } from "react";
import { CheckCircle2 } from "lucide-react";
import { FormField } from "@/components/patterns/form-field";
import { Alert } from "@/components/ui/alert";
import { CheckboxField } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/action-result";
import { fieldError, formDefaults, FormError, SubmitButton } from "@/features/clients/form-bits";

type Action = (state: ActionResult | null, f: FormData) => Promise<ActionResult>;

export function BasicsForm({
  action,
  saved,
  submitLabel,
  locked = false,
}: {
  action: Action;
  saved?: { name: string; goal: string; channels: string[] };
  submitLabel: string;
  locked?: boolean;
}) {
  const [state, formAction] = useActionState(action, null);
  const d = formDefaults(state);
  return (
    <form action={formAction} className="grid gap-4">
      <FormError state={state} fields={["name", "goal", "channels"]} />
      {state?.ok && state.message && (
        <Alert variant="success">
          <CheckCircle2 aria-hidden />
          <p>{state.message}</p>
        </Alert>
      )}
      <fieldset disabled={locked} className="grid gap-4">
        <FormField label="Campaign name" hint="Only staff see this." error={fieldError(state, "name")}>
          {(f) => <Input {...f} name="name" maxLength={120} required defaultValue={d.text("name", saved?.name)} placeholder="e.g. February dental month" />}
        </FormField>
        <FormField
          label="Goal"
          hint="What you offer and to whom. Put every price, discount and date here: the message may only use facts from this goal and your clinic details."
          error={fieldError(state, "goal")}
        >
          {(f) => <Textarea {...f} name="goal" rows={4} maxLength={1000} required defaultValue={d.text("goal", saved?.goal)} placeholder="e.g. February is dental month: 10% off dental cleaning for dogs and cats, book by February 28." />}
        </FormField>
        <FormField label="Send by" error={fieldError(state, "channels")}>
          {(f) => (
          <div className="grid gap-2 sm:grid-cols-2" role="group" aria-describedby={f["aria-describedby"]}>
            <CheckboxField name="channels" value="sms" label="Text message" hint="Clients with marketing and text consent" defaultChecked={d.submitted ? d.has("channels", "sms", undefined) : (saved?.channels.includes("sms") ?? true)} />
            <CheckboxField name="channels" value="email" label="Email" hint="Clients with marketing consent and an email" defaultChecked={d.submitted ? d.has("channels", "email", undefined) : (saved?.channels.includes("email") ?? true)} />
          </div>
          )}
        </FormField>
      </fieldset>
      {!locked && (
        <div className="flex justify-end">
          <SubmitButton pendingText="Saving">{submitLabel}</SubmitButton>
        </div>
      )}
    </form>
  );
}
