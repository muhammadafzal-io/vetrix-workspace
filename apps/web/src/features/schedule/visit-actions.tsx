"use client";

// Visit status from the schedule: check in, no-show, and complete (with the
// weight and the vaccines given). Rules live in @vetrix/domain; this only
// shows the buttons visitChangesFor() allows and posts to the server actions.
import { useActionState, useState } from "react";
import { AlertCircle, CheckCircle2, LogIn, UserX } from "lucide-react";
import { visitChangesFor } from "@vetrix/domain";
import type { VaccineChoice } from "@vetrix/db/runtime";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { ActionResult } from "@/lib/action-result";
import { SubmitButton } from "@/features/clients/form-bits";

type Action = (state: ActionResult | null, f: FormData) => Promise<ActionResult>;

function ErrorNote({ state }: { state: ActionResult | null }) {
  if (!state || state.ok) return null;
  return (
    <Alert variant="error">
      <AlertCircle aria-hidden />
      <p>{state.error}</p>
    </Alert>
  );
}

function StatusButton({ action, children, variant }: { action: Action; children: React.ReactNode; variant: "outline" | "ghost" }) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className="grid gap-2">
      <ErrorNote state={state} />
      <Button type="submit" variant={variant} size="sm" disabled={pending} className="w-full">
        {children}
      </Button>
    </form>
  );
}

export function VisitActions({
  status,
  petName,
  checkIn,
  noShow,
  complete,
  vaccines,
  canRecordVaccines,
}: {
  status: string;
  petName: string;
  checkIn: Action;
  noShow: Action;
  complete: Action;
  vaccines: VaccineChoice[];
  canRecordVaccines: boolean;
}) {
  const [completing, setCompleting] = useState(false);
  const [state, formAction] = useActionState(complete, null);
  const changes = visitChangesFor(status);
  if (changes.length === 0) return null;
  const previous = state && !state.ok ? state.values : undefined;
  const chosen = new Set([previous?.vaccineIds ?? []].flat());

  if (completing) {
    return (
      <form action={formAction} className="grid gap-3 rounded-lg border bg-muted/40 p-3">
        <p className="text-small font-medium">Complete {petName}&apos;s visit</p>
        <ErrorNote state={state} />
        <label className="grid gap-1.5 text-small font-medium">
          Weight (kg) <span className="font-normal text-muted-foreground">optional</span>
          <Input name="weightKg" inputMode="decimal" autoComplete="off" placeholder="e.g. 18.4" defaultValue={typeof previous?.weightKg === "string" ? previous.weightKg : ""} />
        </label>
        {canRecordVaccines && vaccines.length > 0 && (
          <fieldset className="grid gap-2">
            <legend className="mb-1.5 text-small font-medium">Vaccines given at this visit</legend>
            {vaccines.map((v) => (
              <CheckboxField
                key={v.id}
                name="vaccineIds"
                value={v.id}
                defaultChecked={chosen.has(v.id)}
                label={v.name}
                hint={`Next due in ${v.default_interval_months} months${v.core ? " · core" : ""}`}
              />
            ))}
          </fieldset>
        )}
        <p className="text-caption text-muted-foreground">
          Vaccines move {petName}&apos;s reminders to the next due date. Clinical notes stay in your practice software.
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setCompleting(false)}>
            Back
          </Button>
          <SubmitButton pendingText="Saving">Complete visit</SubmitButton>
        </div>
      </form>
    );
  }

  return (
    <div className="grid gap-2">
      {changes.includes("checked_in") && (
        <StatusButton action={checkIn} variant="outline">
          <LogIn aria-hidden /> Check in
        </StatusButton>
      )}
      {changes.includes("completed") && (
        <Button size="sm" onClick={() => setCompleting(true)}>
          <CheckCircle2 aria-hidden /> Complete visit
        </Button>
      )}
      {changes.includes("no_show") && (
        <StatusButton action={noShow} variant="ghost">
          <UserX aria-hidden /> Mark as no-show
        </StatusButton>
      )}
    </div>
  );
}
