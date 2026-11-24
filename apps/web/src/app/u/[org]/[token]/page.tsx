// Public page behind the "Stop these emails" link in a campaign email.
// No sign-in: the long random token is the key. Opening the page changes
// nothing (email scanners open links); the client confirms with a button.
// Clinic branding only.
import type { Metadata } from "next";
import { CheckCircle2, MailX } from "lucide-react";
import { unsubscribeByLink, unsubscribeLink } from "@vetrix/db/runtime";
import { Button } from "@/components/ui/button";
import { logger } from "@/lib/logger";
import { tenancy } from "@/lib/tenancy";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Email preferences", robots: { index: false, follow: false }, referrer: "no-referrer" };

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

async function load(org: string, token: string) {
  if (!SLUG.test(org)) return null;
  try {
    const { pool } = await tenancy().clinicPool(org);
    return { pool, link: await unsubscribeLink(pool, token) };
  } catch (error) {
    logger.warn("unsubscribe link could not be loaded", { error: (error as Error).name });
    return null;
  }
}

export default async function UnsubscribePage({ params, searchParams }: { params: Promise<{ org: string; token: string }>; searchParams: Promise<{ done?: string }> }) {
  const { org, token } = await params;
  const done = (await searchParams).done === "1";
  const found = await load(org, token);
  const link = found?.link ?? null;

  async function confirm() {
    "use server";
    const again = await load(org, token);
    if (again?.link) await unsubscribeByLink(again.pool, token);
    const { redirect } = await import("next/navigation");
    redirect(`/u/${org}/${token}?done=1`);
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="grid w-full max-w-md gap-4 rounded-xl border bg-card p-6 text-center shadow-card">
        {!link ? (
          <>
            <MailX className="mx-auto size-10 text-muted-foreground" aria-hidden />
            <h1 className="text-h3 font-semibold">This link is not valid</h1>
            <p className="text-small text-muted-foreground">To stop these emails, please call the clinic.</p>
          </>
        ) : done || link.alreadyOff ? (
          <>
            <CheckCircle2 className="mx-auto size-10 text-primary" aria-hidden />
            <h1 className="text-h3 font-semibold">You will not get marketing emails</h1>
            <p className="text-small text-muted-foreground">
              {link.clinicName} will no longer send you offers or news. You will still get messages about your pets&apos; visits, such as confirmations and reminders.
            </p>
          </>
        ) : (
          <>
            <MailX className="mx-auto size-10 text-primary" aria-hidden />
            <h1 className="text-h3 font-semibold">Stop marketing emails from {link.clinicName}?</h1>
            <p className="text-small text-muted-foreground">
              Hi {link.clientFirstName}, you will no longer get offers or news. Messages about your pets&apos; visits still reach you.
            </p>
            <form action={confirm}>
              <Button type="submit" className="w-full">Stop marketing emails</Button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
