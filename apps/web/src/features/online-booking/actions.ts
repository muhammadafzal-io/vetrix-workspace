"use server";

// Public: a client books from the link in a reminder. The token is the only
// key; requests are rate limited per visitor.
import { headers } from "next/headers";
import { bookFromLink, bookingLinkTimes, linkLocationId, queuedMessages, withTransaction } from "@vetrix/db/runtime";
import { isBookingToken } from "@vetrix/domain";
import { getMessagingMode } from "@/lib/env";
import { logger } from "@/lib/logger";
import { deliverQueued } from "@/lib/outbound";
import { createLimiter } from "@/lib/rate-limit";
import { tenancy } from "@/lib/tenancy";

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const limits = {
  times: createLimiter({ limit: 60, windowMs: 10 * 60_000 }),
  book: createLimiter({ limit: 10, windowMs: 10 * 60_000 }),
};

async function visitor(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}

const valid = (org: string, token: string, patientId: string) => SLUG.test(org) && isBookingToken(token) && UUID.test(patientId);

export type TimesResult =
  | { status: "ok"; days: { date: string; times: { start: number; providerId: string; providerName: string }[] }[] }
  | { status: "blocked"; message: string }
  | { status: "invalid" | "expired" | "booked" | "busy" | "error" };

export async function linkTimesAction(org: string, token: string, patientId: string): Promise<TimesResult> {
  if (!valid(org, token, patientId)) return { status: "invalid" };
  if (!limits.times.take(await visitor())) return { status: "busy" };
  try {
    const { pool } = await tenancy().clinicPool(org);
    return await bookingLinkTimes(pool, { token, patientId, now: Date.now() });
  } catch (error) {
    logger.error("online booking times failed", { error });
    return { status: "error" };
  }
}

export type BookResult =
  | { status: "booked"; petName: string; serviceName: string; start: number; providerName: string; confirmation: "sms" | "email" | null }
  | { status: "taken" | "invalid" | "expired" | "already_booked" | "busy" | "error" }
  | { status: "blocked"; message?: string };

export async function bookLinkAction(org: string, token: string, patientId: string, start: number, providerId: string): Promise<BookResult> {
  if (!valid(org, token, patientId) || !Number.isFinite(start) || !UUID.test(providerId)) return { status: "invalid" };
  if (!limits.book.take(await visitor())) return { status: "busy" };
  try {
    const { tenant, pool } = await tenancy().clinicPool(org);
    const sandbox = getMessagingMode() === "sandbox";
    const r = await withTransaction(pool, (tx) => bookFromLink(tx, { token, patientId, start, providerId, now: Date.now(), sandbox }));
    if (r.status !== "booked") return r;
    if (!sandbox) {
      const loc = await linkLocationId(pool, token);
      if (loc) await deliverQueued({ clinic: pool, organizationId: tenant.organization_id, locationId: loc.location_id, clinicName: loc.clinic, messages: await queuedMessages(pool, loc.location_id) });
    }
    return { status: "booked", petName: r.petName, serviceName: r.serviceName, start: r.start.getTime(), providerName: r.providerName, confirmation: r.confirmation };
  } catch (error) {
    logger.error("online booking failed", { error });
    return { status: "error" };
  }
}
