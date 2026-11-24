// Twilio webhook: delivery report for a text we sent (the StatusCallback set
// in lib/outbound.ts). Signature-checked like the other Twilio webhooks, and
// routed to the clinic by the sending number (From is the clinic's number).
// Only "delivered" and carrier failures change the message; Twilio's other
// steps (queued, sending, sent) are ignored.
import { routePhoneNumber, setDeliveryStatus } from "@vetrix/db/runtime";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { tenancy } from "@/lib/tenancy";
import { readTwilioWebhook } from "@/lib/twilio";

export const dynamic = "force-dynamic";

const SID = /^(SM|MM)[0-9a-f]{32}$/i;

export async function POST(request: Request) {
  const check = await readTwilioWebhook(request, getEnv());
  if (!check.ok) {
    logger.warn("twilio status callback rejected", { reason: check.reason });
    return new Response(check.reason, { status: check.status });
  }
  const { MessageSid: sid = "", MessageStatus: state = "", From: from = "", ErrorCode: code } = check.params;
  const status = state === "delivered" ? "delivered" : state === "undelivered" || state === "failed" ? "failed" : null;
  // Always 204 for steps we ignore, so Twilio does not retry them.
  if (!status || !SID.test(sid)) return new Response(null, { status: 204 });

  const t = tenancy();
  const route = await routePhoneNumber(t.registry, from);
  if (!route) {
    logger.warn("twilio status callback for an unassigned number");
    return new Response(null, { status: 204 });
  }
  const { pool } = await t.clinicPool(route.organizationId);
  const found = await setDeliveryStatus(pool, {
    providerMessageId: sid,
    status,
    error: status === "failed" ? `The carrier could not deliver it${code ? ` (Twilio error ${code})` : ""}.` : null,
  });
  if (!found) logger.info("twilio status callback for an unknown message", { status });
  return new Response(null, { status: 204 });
}
