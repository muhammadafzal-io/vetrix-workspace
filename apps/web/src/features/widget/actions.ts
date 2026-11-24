"use server";

// Public booking widget (on the clinic's website and at /w/<org>). No sign-in:
// visitors prove their mobile with a texted code and get a short session
// token, which the widget sends with every request. Rate limited per visitor.
import { headers } from "next/headers";
import {
  continueFrontDesk,
  endFrontDesk,
  numberForLocation,
  queuedMessages,
  startFrontDesk,
  startWidgetCode,
  verifyWidgetCode,
  widgetAddPet,
  widgetBook,
  widgetClinic,
  widgetMe,
  widgetRegister,
  widgetServicesForPet,
  widgetSession,
  widgetSpecies,
  widgetTimes,
  withTransaction,
  type OutboundText,
  type WidgetMe,
  type WidgetService,
  type SqlClient,
  type WidgetSession,
  type BookedVisit,
} from "@vetrix/db/runtime";
import { codeText, formatPhone, isWidgetCode, normalizePhone, trace, traced, type AgeBand, type ChatChoice, type NewClientForm, type TriageLevel } from "@vetrix/domain";
import { conversationAI, triageClassifier } from "@/lib/ai";
import { claimBase } from "@/lib/claim";
import { getEnv, getMessagingMode } from "@/lib/env";
import { logger } from "@/lib/logger";
import { deliverQueued } from "@/lib/outbound";
import { createLimiter } from "@/lib/rate-limit";
import { tenancy } from "@/lib/tenancy";
import { sendSms } from "@/lib/twilio";

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 500;

const g = globalThis as unknown as { vetrixWidgetLimits?: Record<"codes" | "verify" | "reads" | "book" | "chat", ReturnType<typeof createLimiter>> };
g.vetrixWidgetLimits ??= {
  codes: createLimiter({ limit: 6, windowMs: 60 * 60_000 }),
  verify: createLimiter({ limit: 20, windowMs: 10 * 60_000 }),
  reads: createLimiter({ limit: 120, windowMs: 10 * 60_000 }),
  book: createLimiter({ limit: 10, windowMs: 10 * 60_000 }),
  chat: createLimiter({ limit: 60, windowMs: 10 * 60_000 }),
};
const limits = g.vetrixWidgetLimits;

/** Per-visitor limits run in production only: locally every request looks like the same visitor. */
function take(limiter: ReturnType<typeof createLimiter>, key: string): boolean {
  return getEnv().NODE_ENV !== "production" || limiter.take(key);
}

async function visitor(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}

export type Fail = { ok: false; error: string; reason?: "busy" | "session" | "closed" };
const BUSY: Fail = { ok: false, error: "Too many tries. Please wait a few minutes and try again.", reason: "busy" };
const SESSION: Fail = { ok: false, error: "For your security, please confirm your number again.", reason: "session" };
const CLOSED: Fail = { ok: false, error: "Online booking isn't available right now. Please call us.", reason: "closed" };
const OOPS: Fail = { ok: false, error: "Something went wrong and nothing was changed. Please try again." };

async function clinicFor(org: string, locationId: string) {
  if (!SLUG.test(org) || !UUID.test(locationId)) return null;
  const { tenant, pool } = await tenancy().clinicPool(org);
  const clinic = await widgetClinic(pool, locationId, Date.now());
  return clinic ? { pool, organizationId: tenant.organization_id, clinic } : null;
}

async function withSession(org: string, locationId: string, token: string) {
  const c = await clinicFor(org, locationId);
  if (!c) return { fail: CLOSED } as const;
  const session = await widgetSession(c.pool, { locationId, token: String(token ?? ""), now: Date.now() });
  if (!session) return { fail: SESSION } as const;
  return { ...c, session } as const;
}

function userMessage(error: unknown): string | null {
  return error instanceof Error && (error.name === "ValidationError" || error.name === "RuleViolationError")
    ? ((error as Error & { userMessage?: string }).userMessage ?? error.message)
    : null;
}

/** Sandbox: nothing is sent. Always so for the public sample clinic on the sign-in page. */
const sandbox = (org: string) => getMessagingMode() === "sandbox" || org === getEnv().PUBLIC_SANDBOX_ORG;

// ---------- Codes ----------

export type SendCodeResult = { ok: true; display: string; resendIn: number; sandboxCode: string | null } | Fail;

export async function sendCodeAction(org: string, locationId: string, mobileInput: string): Promise<SendCodeResult> {
  let mobile: string;
  try {
    mobile = normalizePhone(String(mobileInput ?? "").slice(0, 30));
  } catch {
    return { ok: false, error: "Enter a US mobile number, like (512) 555-0142." };
  }
  if (!take(limits.codes, await visitor()) || !take(limits.codes, `m:${mobile}`)) return BUSY;
  try {
    const c = await clinicFor(org, locationId);
    if (!c) return CLOSED;
    const r = await startWidgetCode(c.pool, { locationId, mobile, now: Date.now(), hourlyLimit: !sandbox(org) });
    if (r.status === "wait") return { ok: false, error: `Please wait ${r.seconds} seconds before asking for a new code.` };
    if (r.status === "limit") return { ok: false, error: "That's a lot of codes. Please wait an hour, or call us." };
    if (r.status === "no_text") return { ok: false, error: "We can't text this number (texts were turned off). Please call us and we'll book you in." };
    const body = codeText(c.clinic.name, r.code);
    if (sandbox(org)) return { ok: true, display: formatPhone(r.mobile), resendIn: 30, sandboxCode: r.code };
    const env = getEnv();
    const from = await numberForLocation(tenancy().registry, { organizationId: c.organizationId, locationId });
    if (!from || !env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
      logger.error("widget code not sent: texting is not set up", { locationId });
      return { ok: false, error: "We can't send codes right now. Please call us." };
    }
    const sent = await sendSms({ accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN }, { from, to: r.mobile, body }).catch(() => ({ ok: false, status: 0 }));
    if (!sent.ok) {
      logger.error("widget code text failed", { status: sent.status });
      return { ok: false, error: "We couldn't text that number. Check it, or call us." };
    }
    return { ok: true, display: formatPhone(r.mobile), resendIn: 30, sandboxCode: null };
  } catch (error) {
    logger.error("widget code failed", { error });
    return OOPS;
  }
}

export type VerifyResult = { ok: true; token: string; me: WidgetMe | null; species: string[] } | Fail;

export async function verifyCodeAction(org: string, locationId: string, mobileInput: string, code: string): Promise<VerifyResult> {
  if (!isWidgetCode(String(code ?? ""))) return { ok: false, error: "Enter the 6-digit code." };
  if (!take(limits.verify, await visitor())) return BUSY;
  try {
    const c = await clinicFor(org, locationId);
    if (!c) return CLOSED;
    const r = await withTransaction(c.pool, (tx) => verifyWidgetCode(tx, { locationId, mobile: String(mobileInput ?? ""), code, now: Date.now() }));
    if (r.status === "expired") return { ok: false, error: "That code has expired. Send a new one." };
    if (r.status === "wrong") return { ok: false, error: `That code isn't right. ${r.triesLeft} ${r.triesLeft === 1 ? "try" : "tries"} left.` };
    const [me, species] = await Promise.all([
      r.session.clientId ? widgetMe(c.pool, { locationId, clientId: r.session.clientId, now: Date.now(), timezone: c.clinic.timezone }) : null,
      widgetSpecies(c.pool, locationId),
    ]);
    return { ok: true, token: r.token, me, species };
  } catch (error) {
    const message = userMessage(error);
    if (!message) logger.error("widget verify failed", { error });
    return message ? { ok: false, error: message } : OOPS;
  }
}

// ---------- The client ----------

export type MeResult = { ok: true; me: WidgetMe } | Fail;

export async function meAction(org: string, locationId: string, token: string): Promise<MeResult> {
  if (!take(limits.reads, await visitor())) return BUSY;
  try {
    const s = await withSession(org, locationId, token);
    if ("fail" in s) return s.fail!;
    if (!s.session.clientId) return SESSION;
    return { ok: true, me: await widgetMe(s.pool, { locationId, clientId: s.session.clientId, now: Date.now(), timezone: s.clinic.timezone }) };
  } catch (error) {
    logger.error("widget me failed", { error });
    return OOPS;
  }
}

export interface PetForm {
  petName: string;
  species: string;
  ageBand: string;
  sex: string;
}

const petFields = (f: PetForm) => ({
  petName: String(f.petName ?? "").slice(0, 80),
  species: String(f.species ?? "") as NewClientForm["species"],
  ageBand: String(f.ageBand ?? "") as AgeBand,
  sex: (f.sex === "male" || f.sex === "female" ? f.sex : null) as NewClientForm["sex"],
});

export type RegisterResult = { ok: true; me: WidgetMe; patientId: string } | (Fail & { field?: string });

export async function registerAction(
  org: string,
  locationId: string,
  token: string,
  form: PetForm & { firstName: string; lastName: string; email: string; smsConsent: boolean },
): Promise<RegisterResult> {
  if (!take(limits.book, await visitor())) return BUSY;
  try {
    const s = await withSession(org, locationId, token);
    if ("fail" in s) return s.fail!;
    const now = Date.now();
    const { clientId, patientId } = await withTransaction(s.pool, (tx) =>
      widgetRegister(tx, {
        locationId,
        timezone: s.clinic.timezone,
        session: s.session,
        now,
        form: {
          firstName: String(form.firstName ?? "").slice(0, 80),
          lastName: String(form.lastName ?? "").slice(0, 80),
          email: String(form.email ?? "").slice(0, 200),
          smsConsent: form.smsConsent === true,
          ...petFields(form),
        },
      }),
    );
    return { ok: true, patientId, me: await widgetMe(s.pool, { locationId, clientId, now, timezone: s.clinic.timezone }) };
  } catch (error) {
    const message = userMessage(error);
    if (!message) logger.error("widget register failed", { error });
    return message ? { ok: false, error: message, field: (error as { details?: { field?: string } }).details?.field } : OOPS;
  }
}

export async function addPetAction(org: string, locationId: string, token: string, form: PetForm): Promise<RegisterResult> {
  if (!take(limits.book, await visitor())) return BUSY;
  try {
    const s = await withSession(org, locationId, token);
    if ("fail" in s) return s.fail!;
    if (!s.session.clientId) return SESSION;
    const now = Date.now();
    const patientId = await withTransaction(s.pool, (tx) => widgetAddPet(tx, { locationId, timezone: s.clinic.timezone, session: s.session, pet: petFields(form), now }));
    return { ok: true, patientId, me: await widgetMe(s.pool, { locationId, clientId: s.session.clientId, now, timezone: s.clinic.timezone }) };
  } catch (error) {
    const message = userMessage(error);
    if (!message) logger.error("widget add pet failed", { error });
    return message ? { ok: false, error: message, field: (error as { details?: { field?: string } }).details?.field } : OOPS;
  }
}

// ---------- Booking ----------

export type ServicesResult = { ok: true; services: WidgetService[] } | Fail;

export async function servicesAction(org: string, locationId: string, token: string, patientId: string): Promise<ServicesResult> {
  if (!UUID.test(patientId)) return OOPS;
  if (!take(limits.reads, await visitor())) return BUSY;
  try {
    const s = await withSession(org, locationId, token);
    if ("fail" in s) return s.fail!;
    if (!s.session.clientId) return SESSION;
    const services = await widgetServicesForPet(s.pool, { locationId, clientId: s.session.clientId, patientId, timezone: s.clinic.timezone, now: Date.now() });
    if (!services) return { ok: false, error: "That pet could not be found. Please call us." };
    return { ok: true, services };
  } catch (error) {
    logger.error("widget services failed", { error });
    return OOPS;
  }
}

export type TimesResult =
  | { ok: true; days: { date: string; times: { start: number; providerId: string; providerName: string }[] }[] }
  | { ok: false; error: string; reason?: Fail["reason"] | "blocked" };

export async function timesAction(org: string, locationId: string, token: string, patientId: string, serviceId: string): Promise<TimesResult> {
  if (!UUID.test(patientId) || !UUID.test(serviceId)) return OOPS;
  if (!take(limits.reads, await visitor())) return BUSY;
  try {
    const s = await withSession(org, locationId, token);
    if ("fail" in s) return s.fail!;
    const r = await widgetTimes(s.pool, { locationId, timezone: s.clinic.timezone, session: s.session, patientId, serviceId, now: Date.now() });
    if (r.status === "ok") return { ok: true, days: r.days };
    if (r.status === "blocked") return { ok: false, error: r.message, reason: "blocked" };
    return { ok: false, error: "Please call us about this pet." };
  } catch (error) {
    const message = userMessage(error);
    if (!message) logger.error("widget times failed", { error });
    return message ? { ok: false, error: message } : OOPS;
  }
}

export type BookResult =
  | { ok: true; petName: string; serviceName: string; start: number; providerName: string; confirmation: "sms" | "email" | null }
  | { ok: false; error: string; reason?: Fail["reason"] | "taken" | "blocked" | "already_booked" };

export async function bookAction(org: string, locationId: string, token: string, patientId: string, serviceId: string, start: number, providerId: string): Promise<BookResult> {
  if (!UUID.test(patientId) || !UUID.test(serviceId) || !UUID.test(providerId) || !Number.isFinite(start)) return OOPS;
  if (!take(limits.book, await visitor())) return BUSY;
  try {
    const s = await withSession(org, locationId, token);
    if ("fail" in s) return s.fail!;
    const isSandbox = sandbox(org);
    const r = await withTransaction(s.pool, (tx) =>
      widgetBook(tx, { locationId, clinicName: s.clinic.name, timezone: s.clinic.timezone, session: s.session, patientId, serviceId, start, providerId, now: Date.now(), sandbox: isSandbox }),
    );
    if (r.status === "taken") return { ok: false, error: "Sorry, that time was just taken. Here are the times still free.", reason: "taken" };
    if (r.status === "already_booked") return { ok: false, error: "This visit is already booked for your pet.", reason: "already_booked" };
    if (r.status !== "booked") return { ok: false, error: r.message ?? "Please call us to book this visit.", reason: "blocked" };
    if (!isSandbox && s.session.clientId) {
      const clientId = s.session.clientId;
      const queued = (await queuedMessages(s.pool, locationId)).filter((m) => m.clientId === clientId);
      await deliverQueued({ clinic: s.pool, organizationId: s.organizationId, locationId, clinicName: s.clinic.name, messages: queued });
    }
    return { ok: true, petName: r.petName, serviceName: r.serviceName, start: r.start.getTime(), providerName: r.providerName, confirmation: r.confirmation };
  } catch (error) {
    const message = userMessage(error);
    if (!message) logger.error("widget booking failed", { error });
    return message ? { ok: false, error: message } : OOPS;
  }
}

// ---------- Chat with the AI front desk ----------

/**
 * One turn of the website chat. `triageLevel` drives the emergency card;
 * `choices` are tappable answers; `bookedNow` the visits just booked.
 */
export type ChatResult =
  | { ok: true; callId: string; replies: string[]; ended: boolean; triageLevel: TriageLevel; choices: ChatChoice[]; bookedNow: BookedVisit[] }
  | Fail;

async function deliverTexts(org: string, organizationId: string, locationId: string, outbound: OutboundText[]) {
  if (sandbox(org) || outbound.length === 0) return;
  const env = getEnv();
  const from = await numberForLocation(tenancy().registry, { organizationId, locationId });
  if (!from || !env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    logger.error("widget chat texts not sent: texting is not set up", { count: outbound.length });
    return;
  }
  for (const o of outbound) {
    const r = await sendSms({ accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN }, { from, to: o.to, body: o.body }).catch(() => ({ ok: false, status: 0 }));
    if (!r.ok) logger.error("widget chat text failed", { status: r.status });
  }
}

/** The conversation must be this visitor's own widget chat. */
async function ownChat(pool: SqlClient, locationId: string, callId: string, session: WidgetSession) {
  if (!UUID.test(callId)) return false;
  const { rows } = await pool.query(`SELECT 1 FROM calls WHERE id = $1 AND location_id = $2 AND channel = 'web' AND caller_number = $3 AND ended_at IS NULL`, [
    callId,
    locationId,
    session.mobile,
  ]);
  return rows.length > 0;
}

export async function chatStartAction(org: string, locationId: string, token: string): Promise<ChatResult> {
  trace("action", "features/widget/actions.ts › chatStartAction", "browser asked to start a chat (server action = a POST to this page)");
  if (!take(limits.chat, await visitor())) return BUSY;
  try {
    const s = await withSession(org, locationId, token);
    if ("fail" in s) return s.fail!;
    const r = await traced(
      "db",
      "db/front-desk.ts › startFrontDesk",
      "open a conversation: find the caller, greet, save a calls row",
      () => startFrontDesk(s.pool, { locationId, channel: "web", callerNumber: s.session.mobile, sandbox: sandbox(org) }),
      (t) => `conversation ${t.callId.slice(0, 8)}… started, ${t.replies.length} greeting line(s)`,
    );
    return { ok: true, callId: r.callId, replies: r.replies, ended: r.ended, triageLevel: r.triageLevel, choices: r.choices, bookedNow: r.bookedNow };
  } catch (error) {
    logger.error("widget chat start failed", { error });
    return OOPS;
  }
}

export async function chatSendAction(org: string, locationId: string, token: string, callId: string, text: string): Promise<ChatResult> {
  const HERE = "features/widget/actions.ts › chatSendAction";
  const body = String(text ?? "").trim().slice(0, MAX_TEXT);
  trace("action", HERE, `① browser sent a chat message (${body.length} characters) as a server action`);
  if (!body) return { ok: false, error: "Type a message." };
  if (!take(limits.chat, await visitor())) return BUSY;
  try {
    const s = await withSession(org, locationId, token);
    if ("fail" in s) {
      trace("action", HERE, "widget session missing or expired → ask for the code again");
      return s.fail!;
    }
    trace("action", HERE, "② clinic found and widget session valid (features/widget/actions.ts › withSession)");
    if (!(await ownChat(s.pool, locationId, callId, s.session))) return { ok: false, error: "This chat has ended. Start a new one.", reason: "session" };
    trace("action", HERE, "③ this chat belongs to this person → hand the message to the front desk");
    const r = await traced(
      "db",
      "db/front-desk.ts › continueFrontDesk",
      "one turn of the conversation, inside one database transaction",
      () => continueFrontDesk(s.pool, { locationId, callId, text: body }, Date.now(), { classify: triageClassifier(), ai: conversationAI(), claimBase: claimBase(s.organizationId) }),
      (t) => `turn saved: ${t.replies.length} reply line(s), triage ${t.triageLevel}, ${t.notes.length} staff note(s)${t.ended ? ", conversation ended" : ""}`,
    );
    await deliverTexts(org, s.organizationId, locationId, r.outbound);
    trace("action", HERE, `⑦ ${r.outbound.length} text(s) to send (sandbox sends none) → return the replies to the browser, React shows them`);
    return { ok: true, callId, replies: r.replies, ended: r.ended, triageLevel: r.triageLevel, choices: r.choices, bookedNow: r.bookedNow };
  } catch (error) {
    const message = userMessage(error);
    if (!message) logger.error("widget chat failed", { error });
    return message ? { ok: false, error: message } : OOPS;
  }
}

export async function chatEndAction(org: string, locationId: string, token: string, callId: string): Promise<void> {
  try {
    const s = await withSession(org, locationId, token);
    if ("fail" in s) return;
    if (await ownChat(s.pool, locationId, callId, s.session)) await endFrontDesk(s.pool, { locationId, callId });
  } catch (error) {
    logger.error("widget chat end failed", { error });
  }
}
