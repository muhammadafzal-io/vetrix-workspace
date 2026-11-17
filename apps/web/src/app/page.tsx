import type { Metadata } from "next";
import { Landing } from "@/features/marketing/landing";
import { getEnv } from "@/lib/env";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Vetrix · The AI front desk for veterinary clinics",
  description:
    "Vetrix answers your clinic's calls and texts, triages safely, books the right doctor, room and equipment, and reminds owners when their pets are due.",
  openGraph: {
    title: "Vetrix · The AI front desk for veterinary clinics",
    description: "Every call answered. Every pet brought back.",
    type: "website",
  },
};

/** The website, for everyone. Signed-in staff get an "Open Vetrix" button instead of "Sign in". */
export default async function Home() {
  const signedIn = Boolean(await getSession().catch(() => null));
  const env = getEnv();
  // The live booking widget for the sample clinic (always Sandbox).
  const sampleOrg = env.PUBLIC_SANDBOX_ORG;
  return (
    <>
      <Landing tryIt={Boolean(sampleOrg)} contactEmail={env.PUBLIC_CONTACT_EMAIL ?? null} signedIn={signedIn} />
      {sampleOrg && <script src="/widget.js" data-clinic={sampleOrg} data-mode="modal" async />}
    </>
  );
}
