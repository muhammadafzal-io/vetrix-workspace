import type { Metadata } from "next";
import { Building2, Database } from "lucide-react";
import { listClinics, type ClinicSummary } from "@vetrix/db/clinic-setup";
import { Panel } from "@/components/patterns/detail-list";
import { EmptyState } from "@/components/patterns/empty-state";
import { PageHeader } from "@/components/patterns/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { AddClinicForm, ResendInviteButton, RetryButton } from "@/features/clinics/clinic-forms";
import { getEnv } from "@/lib/env";
import { requirePlatformAdmin } from "@/lib/session";
import { tenancy } from "@/lib/tenancy";

export const metadata: Metadata = { title: "Clinics · Admin · Vetrix" };
// Creating a Neon database and its tables can take up to a minute.
export const maxDuration = 300;

const STATUS: Record<ClinicSummary["status"], { label: string; variant: "success" | "warning" | "muted" | "danger" }> = {
  active: { label: "Active", variant: "success" },
  provisioning: { label: "Setting up", variant: "warning" },
  migrating: { label: "Updating", variant: "warning" },
  suspended: { label: "Suspended", variant: "muted" },
};

const date = (d: Date) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(d);

export default async function ClinicsPage() {
  await requirePlatformAdmin();
  const env = getEnv();
  const clinics = await listClinics(tenancy().registry);
  const missing = [!env.NEON_API_KEY && "NEON_API_KEY", !env.DATABASE_SECRETS_KEY && "DATABASE_SECRETS_KEY"].filter(Boolean) as string[];
  const timezones = Intl.supportedValuesOf("timeZone").filter((tz) => tz.includes("/"));

  return (
    <>
      <PageHeader
        title="Clinics"
        description={`${clinics.length} ${clinics.length === 1 ? "clinic" : "clinics"}. Each has its own database.`}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section className="grid content-start gap-2" aria-label="Clinics">
          {clinics.length === 0 ? (
            <EmptyState icon={Building2} title="No clinics yet" description="Add the first clinic with the form." />
          ) : (
            clinics.map((c) => (
              <div key={c.tenantId} className="grid gap-3 rounded-xl border bg-card p-4 shadow-card">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="grid gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{c.name}</span>
                      <Badge variant={c.running ? "warning" : STATUS[c.status].variant}>{c.running ? "Working…" : STATUS[c.status].label}</Badge>
                    </div>
                    <span className="text-small text-muted-foreground">
                      {c.slug} · {c.ownerEmail ?? "added from the command line"} · {date(c.createdAt)}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-start gap-2">
                    {c.status === "provisioning" && !c.running && c.ownerEmail && <RetryButton tenantId={c.tenantId} />}
                    {c.status === "active" && c.ownerEmail && <ResendInviteButton tenantId={c.tenantId} />}
                  </div>
                </div>
                <div className="flex flex-wrap gap-x-5 gap-y-1 text-caption text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Database className="size-3.5" aria-hidden /> {c.region}
                  </span>
                  <span>Schema {c.schemaVersion ?? "not created"}</span>
                  {c.neonProjectId && <span>Neon project {c.neonProjectId}</span>}
                </div>
                {c.lastError && <Alert variant="error">{c.lastError}</Alert>}
              </div>
            ))
          )}
        </section>
        <Panel title="Add a clinic">
          {missing.length > 0 ? (
            <Alert variant="warning">
              Set {missing.join(" and ")} on the server to add clinics. See the comments in apps/web/src/lib/env.ts.
            </Alert>
          ) : (
            <AddClinicForm timezones={timezones} defaultTimezone="America/New_York" />
          )}
          <p className="text-caption text-muted-foreground">
            Vetrix creates the clinic&apos;s database, its tables and first location, then emails the owner a link to set a password. The owner finishes setup in
            Settings.
          </p>
        </Panel>
      </div>
    </>
  );
}
