import type { Metadata } from "next";
import { PageHeader } from "@/components/patterns/page-header";
import { Panel } from "@/components/patterns/detail-list";
import { requirePage } from "@/features/clients/access";
import { createCampaignAction } from "@/features/campaigns/actions";
import { AiRequestForm } from "@/features/campaigns/ai-request-form";
import { BasicsForm } from "@/features/campaigns/basics-form";
import { aiMode } from "@/lib/ai";

export const metadata: Metadata = { title: "New campaign · Vetrix" };

export default async function NewCampaignPage() {
  await requirePage("campaigns.manage");
  return (
    <>
      <PageHeader title="New campaign" description="Describe it and AI sets it up, or build it step by step. Either way you check it and approve before anything is sent." />
      <div className="grid max-w-4xl gap-6">
        <Panel title="Describe it, AI sets it up">
          <AiRequestForm aiLive={aiMode() === "openai"} />
        </Panel>
        <details className="group rounded-xl border bg-card shadow-card">
          <summary className="cursor-pointer px-5 py-4 text-body font-semibold">Or set it up yourself</summary>
          <div className="border-t p-5">
            <BasicsForm action={createCampaignAction} submitLabel="Continue" />
          </div>
        </details>
      </div>
    </>
  );
}
