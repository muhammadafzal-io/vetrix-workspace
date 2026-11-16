// Public online booking page, opened from the link in a reminder.
// No sign-in: the long random token is the key. It shows the clinic, the
// client's first name and their pets' names, and nothing else about them.
// Clinic branding only (Vetrix branding stays in the staff app).
import type { Metadata } from "next";
import { Phone } from "lucide-react";
import { loadBookingLink, type BookingLinkView } from "@vetrix/db/runtime";
import { formatPhone, isBookingToken } from "@vetrix/domain";
import { BookingFlow } from "@/features/online-booking/booking-flow";
import { logger } from "@/lib/logger";
import { tenancy } from "@/lib/tenancy";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Book a visit", robots: { index: false, follow: false }, referrer: "no-referrer" };

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function phoneText(p: string | null): { text: string; href: string } | null {
  if (!p) return null;
  const digits = p.replace(/\D/g, "");
  const e164 = p.startsWith("+") ? p : digits.length === 10 ? `+1${digits}` : null;
  if (!e164) return { text: p, href: `tel:${digits}` };
  try {
    return { text: formatPhone(e164), href: `tel:${e164}` };
  } catch {
    return { text: p, href: `tel:${digits}` };
  }
}

export default async function OnlineBookingPage({ params }: { params: Promise<{ org: string; token: string }> }) {
  const { org, token } = await params;
  let view: BookingLinkView | null = null;
  if (SLUG.test(org) && isBookingToken(token)) {
    try {
      view = await loadBookingLink((await tenancy().clinicPool(org)).pool, token, Date.now());
    } catch (error) {
      logger.warn("online booking link could not be loaded", { error: (error as Error).name });
    }
  }
  const phone = phoneText(view?.clinicPhone ?? null);

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-body font-semibold text-primary-foreground" aria-hidden>
            {(view?.clinicName ?? "?").charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{view?.clinicName ?? "Book a visit"}</p>
            <p className="text-caption text-muted-foreground">Online booking</p>
          </div>
          {phone && (
            <a href={phone.href} className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-small font-medium hover:bg-muted">
              <Phone className="size-4" aria-hidden /> <span className="hidden sm:inline">{phone.text}</span>
              <span className="sm:hidden">Call</span>
            </a>
          )}
        </div>
      </header>
      <main className="mx-auto grid max-w-2xl gap-6 px-4 py-6 sm:py-10">
        {!view ? (
          <Notice title="This link isn't working" body="It may have been copied incompletely. Reply to the text you received, or call the clinic, and we'll book you in." />
        ) : view.expired ? (
          <Notice
            title="This booking link has expired"
            body={`Links work for a few weeks after they're sent. Reply to the text or call ${view.clinicName}${phone ? ` at ${phone.text}` : ""} and we'll find you a time.`}
          />
        ) : (
          <BookingFlow
            org={org}
            token={token}
            firstName={view.firstName}
            clinicName={view.clinicName}
            clinicPhone={phone}
            timezone={view.timezone}
            pets={view.pets.map((p) => ({
              patientId: p.patientId,
              name: p.name,
              serviceName: p.serviceName,
              booked: p.booked ? { start: p.booked.start.getTime(), serviceName: p.booked.serviceName } : null,
              unavailable: p.unavailable === "not_active" ? "Please call us about this pet." : p.unavailable,
            }))}
          />
        )}
      </main>
    </div>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <section className="grid gap-2 rounded-xl border bg-card p-6 text-center shadow-card">
      <h1 className="text-h3 font-semibold">{title}</h1>
      <p className="text-muted-foreground">{body}</p>
    </section>
  );
}
