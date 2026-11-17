// Public booking widget page: /w/<org> (hosted link for Google, Facebook and
// texts) and /w/<org>?embed=1 (inside the frame from widget.js on the
// clinic's own website). Clinic branding only. Which sites may frame this page
// is set per clinic (Settings → Booking widget) and enforced in middleware.
import type { Metadata } from "next";
import { numberForLocation, widgetClinic, widgetLocations } from "@vetrix/db/runtime";
import { BrandBackdrop } from "@/components/vetrix/brand-backdrop";
import { BookingWidget, type WidgetClinicProps } from "@/features/widget/widget";
import { logger } from "@/lib/logger";
import { getEnv } from "@/lib/env";
import { tenancy } from "@/lib/tenancy";
import { phoneLink } from "@/lib/widget-phone";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Book a visit", robots: { index: false, follow: false }, referrer: "no-referrer" };

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function load(org: string, wanted: string | undefined): Promise<{ clinic: WidgetClinicProps | null; choices: { id: string; name: string }[] }> {
  if (!SLUG.test(org)) return { clinic: null, choices: [] };
  try {
    const t = tenancy();
    const { tenant, pool } = await t.clinicPool(org);
    const locations = await widgetLocations(pool);
    const pick = locations.find((l) => l.id === wanted) ?? (locations.length === 1 ? locations[0] : undefined);
    if (!pick) return { clinic: null, choices: locations };
    const c = await widgetClinic(pool, pick.id, Date.now());
    if (!c) return { clinic: null, choices: [] };
    // "Call us" rings the clinic's front desk number, which the AI answers.
    // The public sample clinic uses the number set for the sign-in page.
    const env = getEnv();
    const line =
      org === env.PUBLIC_SANDBOX_ORG && env.PUBLIC_CALL_NUMBER
        ? env.PUBLIC_CALL_NUMBER
        : await numberForLocation(t.registry, { organizationId: tenant.organization_id, locationId: c.locationId }).catch(() => null);
    return {
      clinic: {
        org,
        locationId: c.locationId,
        name: c.name,
        address: c.address,
        timezone: c.timezone,
        aiName: c.aiName,
        open: c.open,
        phone: phoneLink(line ?? c.phone),
        er: c.er ? { name: c.er.name, address: c.er.address, phone: phoneLink(c.er.phone)! } : null,
      },
      choices: [],
    };
  } catch (error) {
    logger.warn("booking widget could not load", { error: (error as Error).name });
    return { clinic: null, choices: [] };
  }
}

/** A clinic's own colour from the embed code (?color=1d4ed8), with a darker shade for hovers. */
function brandStyle(color: string | undefined): React.CSSProperties | undefined {
  if (!color || !/^[0-9a-f]{6}$/i.test(color)) return undefined;
  const dark = color.match(/../g)!.map((h) => Math.round(parseInt(h, 16) * 0.85).toString(16).padStart(2, "0")).join("");
  return { "--widget-brand": `#${color}`, "--widget-brand-dark": `#${dark}` } as React.CSSProperties;
}

export default async function WidgetPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ embed?: string; l?: string; color?: string }> }) {
  const [{ org }, sp] = await Promise.all([params, searchParams]);
  const embed = sp.embed === "1";
  const { clinic, choices } = await load(org, sp.l && UUID.test(sp.l) ? sp.l : undefined);

  const wrap = (children: React.ReactNode) => (
    <div style={brandStyle(sp.color)} className={embed ? "clinic-widget" : "clinic-widget relative min-h-dvh sm:flex sm:items-center sm:justify-center sm:px-4 sm:py-10"}>
      {/* Hosted page: the same navy backdrop as the staff app, the widget card on top. */}
      {!embed && (
        <div className="hidden sm:block">
          <BrandBackdrop />
        </div>
      )}
      <div className={embed ? undefined : "relative mx-auto w-full max-w-[420px]"}>{children}</div>
    </div>
  );

  if (clinic) return wrap(<BookingWidget clinic={clinic} embed={embed} />);
  return wrap(
    <section className="grid min-h-dvh content-center gap-4 bg-background p-6 text-center sm:min-h-0 sm:rounded-2xl sm:border sm:shadow-card">
      {choices.length > 1 ? (
        <>
          <h1 className="text-h2 font-semibold">Choose a location</h1>
          <ul className="grid gap-2">
            {choices.map((l) => (
              <li key={l.id}>
                <a href={`/w/${org}?l=${l.id}${embed ? "&embed=1" : ""}`} className="block rounded-xl border bg-card p-3.5 font-semibold shadow-card hover:bg-muted/60">
                  {l.name}
                </a>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <h1 className="text-h2 font-semibold">Online booking isn&apos;t available</h1>
          <p className="text-muted-foreground">Please call the clinic and we&apos;ll book you in.</p>
        </>
      )}
    </section>,
  );
}
