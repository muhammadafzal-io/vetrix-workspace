import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Logo } from "@/components/vetrix/logo";
import { AdminNav } from "@/features/admin/admin-nav";
import { requirePlatformAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

// The admin dashboard: tools for the people who run Vetrix (platform admins,
// granted with `pnpm db:admin:grant`). Separate from the staff area: a
// platform admin does not need to be staff at any clinic. Everyone else gets
// "not found" for every page under /admin.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requirePlatformAdmin();
  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-30 border-b bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <Link href="/admin" aria-label="Admin dashboard">
              <Logo className="h-7" />
            </Link>
            <span className="rounded-full bg-navy-900 px-2.5 py-0.5 text-caption font-semibold text-white">Admin</span>
          </div>
          <div className="flex items-center gap-4 text-small text-muted-foreground">
            <span className="hidden sm:inline">{admin.email}</span>
            <Link href="/overview" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
              <ArrowLeft className="size-4" aria-hidden /> Open Vetrix
            </Link>
          </div>
        </div>
      </header>
      <div className="mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[200px_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <AdminNav />
        </aside>
        <main className="min-w-0">{children}</main>
      </div>
    </div>
  );
}
