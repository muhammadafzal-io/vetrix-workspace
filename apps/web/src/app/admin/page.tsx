import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Building2, CheckCircle2, Loader2, ShieldCheck, Users } from "lucide-react";
import { platformOverview } from "@vetrix/db/runtime";
import { listClinics } from "@vetrix/db/clinic-setup";
import { PageHeader } from "@/components/patterns/page-header";
import { Panel } from "@/components/patterns/detail-list";
import { Badge } from "@/components/ui/badge";
import { requirePlatformAdmin } from "@/lib/session";
import { tenancy } from "@/lib/tenancy";

export const metadata: Metadata = { title: "Admin dashboard · Vetrix" };

function Stat({ label, value, icon: Icon, href, tone }: { label: string; value: number; icon: typeof Users; href?: string; tone?: "warn" }) {
  const body = (
    <>
      <span className={tone === "warn" && value > 0 ? "flex size-10 items-center justify-center rounded-lg bg-warning-soft text-warning-text" : "flex size-10 items-center justify-center rounded-lg bg-secondary text-primary"}>
        <Icon className="size-5" aria-hidden />
      </span>
      <span className="grid">
        <span className="text-h2 font-semibold tabular-nums">{value}</span>
        <span className="text-small text-muted-foreground">{label}</span>
      </span>
    </>
  );
  const cls = "flex items-center gap-3 rounded-xl border bg-card p-4 shadow-card";
  return href ? (
    <Link href={href} className={`${cls} transition-colors hover:border-primary/40`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export default async function AdminDashboardPage() {
  const admin = await requirePlatformAdmin();
  const registry = tenancy().registry;
  const [o, clinics] = await Promise.all([platformOverview(registry), listClinics(registry)]);
  const attention = clinics.filter((c) => c.lastError);
  const recent = clinics.slice(0, 5);

  return (
    <>
      <PageHeader
        title="Admin dashboard"
        description={`Signed in as ${admin.email}. ${o.clinics} ${o.clinics === 1 ? "clinic" : "clinics"} on Vetrix.`}
      />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Clinics" value={o.clinics} icon={Building2} href="/admin/clinics" />
        <Stat label="Active" value={o.active} icon={CheckCircle2} />
        <Stat label="Being set up" value={o.settingUp} icon={Loader2} />
        <Stat label="Need attention" value={o.needsAttention} icon={AlertTriangle} href="/admin/clinics" tone="warn" />
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="People with an account" value={o.people} icon={Users} />
        <Stat label="Platform admins" value={o.admins} icon={ShieldCheck} />
        <Stat label="Clinics added (30 days)" value={o.addedLast30Days} icon={Building2} />
        <Stat label="Suspended" value={o.suspended} icon={Building2} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Panel
          title="Needs attention"
          action={
            attention.length > 0 ? (
              <Link href="/admin/clinics" className="text-small font-medium text-primary hover:underline">
                Open Clinics
              </Link>
            ) : undefined
          }
        >
          {attention.length === 0 ? (
            <p className="text-small text-muted-foreground">Nothing to fix. Every clinic finished its setup.</p>
          ) : (
            <ul className="grid gap-2">
              {attention.map((c) => (
                <li key={c.tenantId} className="grid gap-0.5 rounded-lg border border-warning/40 bg-warning-soft/40 px-3 py-2">
                  <span className="text-small font-semibold">{c.name}</span>
                  <span className="text-caption text-muted-foreground">{c.lastError}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel
          title="Latest clinics"
          action={
            <Link href="/admin/clinics" className="inline-flex items-center gap-1 text-small font-medium text-primary hover:underline">
              All clinics <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          }
        >
          <ul className="grid divide-y">
            {recent.map((c) => (
              <li key={c.tenantId} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                <span className="grid min-w-0">
                  <span className="truncate text-small font-medium">{c.name}</span>
                  <span className="truncate text-caption text-muted-foreground">{c.slug}</span>
                </span>
                <Badge variant={c.status === "active" ? "success" : c.status === "suspended" ? "muted" : "warning"}>
                  {c.status === "active" ? "Active" : c.status === "suspended" ? "Suspended" : "Setting up"}
                </Badge>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </>
  );
}
