"use client";

// "Describe it and AI sets it up": one request in, a whole draft campaign out
// (name, channels, audience, text and email). Staff review it on the next page.
import { useActionState } from "react";
import { Sparkles } from "lucide-react";
import { FormField } from "@/components/patterns/form-field";
import { Textarea } from "@/components/ui/textarea";
import { fieldError, formDefaults, FormError, SubmitButton } from "@/features/clients/form-bits";
import { createCampaignWithAiAction } from "./actions";

const EXAMPLES = [
  "Bring back dogs and cats who haven't had a dental cleaning in 12 months. 10% off dental cleaning in February, book by February 28.",
  "Remind owners of senior dogs (8 years or older) not seen in 6 months to book a senior wellness check. Email only.",
  "Pets with an overdue vaccine: ask owners to book a vaccine visit this month. Text and email.",
];

export function AiRequestForm({ aiLive }: { aiLive: boolean }) {
  const [state, formAction] = useActionState(createCampaignWithAiAction, null);
  const d = formDefaults(state);
  return (
    <form action={formAction} className="grid gap-4">
      <FormError state={state} fields={["request"]} />
      <FormField
        label="What should this campaign do?"
        hint="Say who it is for, what you offer and how to send it. Put every price, discount and date here: the messages may only use facts you write."
        error={fieldError(state, "request")}
      >
        {(f) => <Textarea {...f} name="request" rows={4} maxLength={1000} required defaultValue={d.text("request", "")} placeholder={EXAMPLES[0]} />}
      </FormField>
      <details className="text-small">
        <summary className="cursor-pointer font-medium text-primary">Examples</summary>
        <ul className="mt-2 grid list-disc gap-1 pl-5 text-muted-foreground">
          {EXAMPLES.map((e) => <li key={e}>{e}</li>)}
        </ul>
      </details>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-caption text-muted-foreground">
          {aiLive ? "The AI chooses the audience and writes the text and email. Nothing is sent until you approve." : "Sandbox: no AI key is set, so the audience comes from keywords in your request. Nothing is sent until you approve."}
        </p>
        <SubmitButton pendingText="Building the campaign…">
          <Sparkles aria-hidden /> Build with AI
        </SubmitButton>
      </div>
    </form>
  );
}
