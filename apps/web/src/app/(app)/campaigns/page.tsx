import type { Metadata } from "next";
import Link from "next/link";
import { Megaphone, Plus } from "lucide-react";
import { listCampaigns } from "@vetrix/db/runtime";
import { EmptyState } from "@/components/patterns/empty-state";
import { PageHeader } from "@/components/patterns/page-header";
import { Button } from "@/components/ui/button";
import { requirePage } from "@/features/clients/access";
import { CampaignStatusBadge } from "@/features/campaigns/status-badge";

export const metadata: Metadata = { title: "Campaigns · Vetrix" };

const when = (d: Date) => new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", year: "numeric" }).format(d);

export default async function CampaignsPage() {
  const shell = await requirePage("campaigns.manage");
  const campaigns = await listCampaigns(shell.clinic, shell.location.id);
  const newButton = (
    <Button asChild variant="outline" className="border-white/30 bg-white text-foreground hover:bg-white/90">
      <Link href="/campaigns/new">
        <Plus aria-hidden /> New campaign
      </Link>
    </Button>
  );
  return (
    <>
      <PageHeader title="Campaigns" description="Texts and emails to groups of clients, written with AI and approved by you." actions={newButton} />
      {campaigns.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="No campaigns yet"
          description="Bring back lapsed clients, promote dental month or remind owners about vaccines. Only clients who agreed to marketing receive them."
          action={
            <Button asChild>
              <Link href="/campaigns/new">
                <Plus aria-hidden /> New campaign
              </Link>
            </Button>
          }
        />
      ) : (
        <ul className="grid gap-2">
          {campaigns.map((c) => (
            <li key={c.id}>
              <Link href={`/campaigns/${c.id}`} className="flex flex-col gap-2 rounded-lg border bg-card p-4 shadow-card transition-colors hover:bg-muted/40 sm:flex-row sm:items-center">
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <p className="flex flex-wrap items-center gap-2 font-semibold">
                    {c.name} <CampaignStatusBadge status={c.status} />
                  </p>
                  <p className="truncate text-small text-muted-foreground">{c.goal}</p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 text-caption text-muted-foreground sm:justify-end">
                  <span>{c.channels.map((ch) => (ch === "sms" ? "Text" : "Email")).join(" + ")}</span>
                  {c.sent + c.skipped > 0 && <span>{c.sent} sent · {c.skipped} skipped</span>}
                  <span>Created {when(c.created_at)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
