import path from "node:path";
import type { NextConfig } from "next";

// Basic protections on every response. A full script CSP needs nonces and is
// added with the first deployment; these headers are safe today.
// The microphone is off everywhere except the two places people talk to the
// AI front desk out loud: the staff test console and the booking widget.
const sharedHeaders = (microphone: boolean) => [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: `camera=(), microphone=${microphone ? "(self)" : "()"}, geolocation=(), payment=()` },
  ...(process.env.NODE_ENV === "production"
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
    : []),
];
const securityHeaders = (microphone: boolean) => [
  ...sharedHeaders(microphone),
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      // The booking widget (/w/...) can be framed by the clinic's own sites:
      // middleware sets its frame-ancestors from the clinic's settings.
      { source: "/((?!w/|calls/sandbox$).*)", headers: securityHeaders(false) },
      { source: "/calls/sandbox", headers: securityHeaders(true) },
      { source: "/w/:path*", headers: sharedHeaders(true) },
    ];
  },
  reactStrictMode: true,
  // No Next.js dev badge: it showed inside the booking widget's frame.
  devIndicators: false,
  // Lets a verification build use its own folder (NEXT_DIST_DIR=.next-verify)
  // so it never overwrites the files of a running `pnpm dev` server.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Cloud Run runs a self-contained server built from this output.
  output: "standalone",
  // Trace files from the monorepo root so the workspace packages are included.
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  transpilePackages: ["@vetrix/domain", "@vetrix/db", "@vetrix/pack"],
  // The admin Clinics page runs the clinic migrations: ship the SQL files with it.
  outputFileTracingIncludes: { "/admin/clinics": ["../../db/migrations/**/*.sql"] },
  // Clinic CSV imports are sent through a server action (each file up to 10 MB).
  experimental: { serverActions: { bodySizeLimit: "25mb" } },
};

export default nextConfig;
