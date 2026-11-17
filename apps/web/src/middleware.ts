// Fast check before staff pages render: no session cookie means straight to
// sign-in, remembering the page so people land back on it. This only looks
// for the cookie; the real check (valid session, staff record, permissions)
// still happens on the server in requireStaff().
import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { widgetFrameOrigins } from "@/lib/widget-frame";

// Public pages: sign-in, waitlist claim links and booking links from texts, and the booking widget.
const PUBLIC_PATHS = ["/sign-in", "/forgot-password", "/reset-password", "/claim", "/b", "/w"];
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  // The booking widget may be framed only by the clinic's own websites.
  if (pathname.startsWith("/w/")) {
    const org = pathname.split("/")[2] ?? "";
    const origins = SLUG.test(org) ? await widgetFrameOrigins(org) : [];
    const response = NextResponse.next();
    response.headers.set("Content-Security-Policy", `frame-ancestors ${["'self'", ...origins].join(" ")}; base-uri 'self'; form-action 'self'; object-src 'none'`);
    return response;
  }
  // The website at "/" is public (the page sends signed-in staff to Overview).
  if (pathname === "/" || PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return NextResponse.next();
  if (getSessionCookie(request, { cookiePrefix: "vetrix" })) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = "/sign-in";
  url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Node.js, so the widget's frame rule can read the clinic database.
  runtime: "nodejs",
  // Everything except the auth API, Next.js assets and static files.
  matcher: ["/((?!api/|_next/|favicon.ico|.*\\.[a-z0-9]+$).*)"],
};
