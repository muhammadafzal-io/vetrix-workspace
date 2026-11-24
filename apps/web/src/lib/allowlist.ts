// Testing real messages without reaching real clients. With MESSAGING_MODE=live
// and MESSAGING_ALLOWLIST set (dev or staging only), a client message is really
// sent only when its email or mobile is on the list; anything else is kept as
// simulated, exactly as in sandbox mode. In production the list is ignored, so
// it can never silently stop messages to real clients.
import "server-only";
import type { Env } from "./env";
import { logger } from "./logger";

let warned = false;

type ListEnv = Pick<Env, "MESSAGING_ALLOWLIST" | "NODE_ENV" | "APP_STAGE">;

/**
 * Read straight from the process every time (not the cached settings): a list
 * added while the server runs must never be missed, or real messages could go
 * to everyone.
 */
function current(): ListEnv {
  const stage = process.env.APP_STAGE === "staging" ? "staging" : "production";
  const node = process.env.NODE_ENV === "production" ? "production" : process.env.NODE_ENV === "test" ? "test" : "development";
  return { MESSAGING_ALLOWLIST: process.env.MESSAGING_ALLOWLIST, NODE_ENV: node, APP_STAGE: stage };
}

function digits(phone: string): string {
  return phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
}

/** The list in force, or null when every recipient may receive messages. */
export function messagingAllowlist(env: ListEnv = current()): { emails: Set<string>; phones: Set<string> } | null {
  const raw = env.MESSAGING_ALLOWLIST?.trim();
  if (!raw) return null;
  if (env.NODE_ENV === "production" && env.APP_STAGE !== "staging") {
    if (!warned) logger.warn("MESSAGING_ALLOWLIST is ignored in production");
    warned = true;
    return null;
  }
  const items = raw.split(/[,;\n]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  return {
    emails: new Set(items.filter((i) => i.includes("@"))),
    phones: new Set(items.filter((i) => !i.includes("@")).map(digits).filter((d) => d.length >= 7)),
  };
}

/** Whether a real message may go to this email or mobile now. */
export function mayReallySend(to: { email?: string | null; phone?: string | null }, env?: ListEnv): boolean {
  const list = messagingAllowlist(env);
  if (!list) return true;
  if (to.email && list.emails.has(to.email.trim().toLowerCase())) return true;
  if (to.phone && list.phones.has(digits(to.phone))) return true;
  return false;
}

/**
 * Not production, and the email provider refused the clinic's sender (domain
 * not verified yet): the sender to try instead, the provider's own test
 * address. It only delivers to the provider account's address.
 */
export function providerTestSender(env: Pick<Env, "NODE_ENV" | "APP_STAGE"> = current()): string | null {
  return env.NODE_ENV !== "production" || env.APP_STAGE === "staging" ? "onboarding@resend.dev" : null;
}
