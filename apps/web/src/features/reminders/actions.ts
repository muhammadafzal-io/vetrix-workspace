"use server";

// Send today's due reminders (Sandbox: saved, not sent) and stop one reminder.
import { revalidatePath } from "next/cache";
import { fillScript, ForbiddenError, formatPhone, isQuietHours, localParts, parseTestRecipients, RuleViolationError, ValidationError } from "@vetrix/domain";
import {
  aiPersonaName,
  loadRetentionInput,
  logReminderTestSend,
  messagingSettings,
  runReminders,
  stopReminder,
  withTransaction,
  type Actor,
  type RunSummary,
} from "@vetrix/db/runtime";
import { getVeterinaryPack } from "@vetrix/pack";
import { providerTestSender } from "@/lib/allowlist";
import { mailProvider, sendEmail } from "@/lib/email";
import { createLimiter } from "@/lib/rate-limit";
import { clinicToday } from "@/lib/clinic-date";
import { getEnv, getMessagingMode } from "@/lib/env";
import { logger } from "@/lib/logger";
import { bookingLinkBase } from "@/lib/booking-link";
import { deliverQueued } from "@/lib/outbound";
import { requireShell } from "@/lib/session";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function allowed() {
  const shell = await requireShell();
  if (!shell.permissions.has("reminders.manage")) throw new ForbiddenError();
  const actor: Actor = { type: "staff", id: shell.access.staffUserId };
  return { shell, actor };
}

export type RunResult = { ok: true; summary: RunSummary; sandbox: boolean } | { ok: false; error: string };

export async function runRemindersAction(asOfInput: string): Promise<RunResult> {
  try {
    const { shell, actor } = await allowed();
    const sandbox = getMessagingMode() === "sandbox";
    const today = clinicToday(shell.location.timezone);
    // Another date only in Sandbox (to check the test data's reference date).
    const asOf = sandbox && ISO.test(asOfInput) ? asOfInput : today;
    const loc = shell.location.id;
    const [settings, aiName, clinicRow] = await Promise.all([
      messagingSettings(shell.clinic, loc),
      aiPersonaName(shell.clinic, loc),
      shell.clinic.query<{ main_phone: string | null }>(`SELECT main_phone FROM locations WHERE id = $1`, [loc]),
    ]);
    const quiet = isQuietHours(localParts(Date.now(), settings.timezone).minutes, settings.quietStart, settings.quietEnd);
    const phone = clinicRow.rows[0]?.main_phone;
    const { summary, outbound } = await withTransaction(shell.clinic, (tx) =>
      runReminders(tx, {
        locationId: loc,
        asOf,
        sandbox,
        quietHours: quiet,
        actor,
        values: { clinicName: settings.clinicName, aiName, clinicPhone: phone ? safeFormat(phone) : "the clinic", bookingLink: "reply to this text", bookingLinkBase: bookingLinkBase(shell.organization.organization_slug) },
      }),
    );

    // Live: send after the run is saved, and record each result.
    if (!sandbox) await deliverQueued({ clinic: shell.clinic, organizationId: shell.organization.organization_id, locationId: loc, clinicName: settings.clinicName, messages: outbound });
    revalidatePath("/reminders");
    revalidatePath("/messages");
    return { ok: true, summary, sandbox };
  } catch (error) {
    if (error instanceof RuleViolationError) return { ok: false, error: error.userMessage }; // e.g. reminders paused
    logger.error("reminder run failed", { error });
    return { ok: false, error: error instanceof ValidationError ? error.userMessage : "The run did not finish. Nothing was sent twice; please try again." };
  }
}

function safeFormat(phone: string) {
  try {
    return formatPhone(phone.startsWith("+") ? phone : `+1${phone.replace(/\D/g, "")}`);
  } catch {
    return phone;
  }
}

export async function stopReminderAction(input: { ruleId: string; patientId: string; dueAt: string }): Promise<{ ok: boolean; error?: string }> {
  try {
    const { shell, actor } = await allowed();
    if (!UUID.test(input.patientId) || !ISO.test(input.dueAt) || !/^[a-z_]+$/.test(input.ruleId)) throw new ValidationError("Choose a reminder.");
    await withTransaction(shell.clinic, (tx) => stopReminder(tx, { locationId: shell.location.id, ...input, actor }));
    revalidatePath("/reminders");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof ValidationError ? error.userMessage : "Could not stop the reminder." };
  }
}

// ---------- Test reminder ----------

const tg = globalThis as unknown as { vetrixReminderTests?: ReturnType<typeof createLimiter> };
/** At most 10 test reminders per person per 10 minutes. */
const testLimit = (tg.vetrixReminderTests ??= createLimiter({ limit: 10, windowMs: 10 * 60_000 }));

/** Sample values: the email reads as a client would see it. */
const SAMPLE = { client_first_name: "Sam", pet_name: "Bella", pet_names_joined: "Bella and Max", vaccine_names: "Rabies and DAPP", product_name: "flea and tick prevention", what: "a wellness exam", slot_1: "this week", slot_2: "next week" };

/**
 * Sends one reminder step (as this clinic runs it, its own schedule included)
 * for real to the addresses typed, marked [TEST], with a sample pet. At any
 * time: it doesn't depend on any pet being due, never creates a reminder or
 * a client message, and is kept in the audit log. Until the sending domain is
 * verified, dev and staging use the email provider's test sender.
 */
export async function sendTestReminderAction(step: string, rawTo: string): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  try {
    const { shell, actor } = await allowed();
    const to = parseTestRecipients(rawTo);
    if (!testLimit.take(shell.access.staffUserId)) throw new ValidationError("Too many test emails. Try again in a few minutes.");
    const m = /^([a-z_]{2,60}):(\d{1,2})$/.exec(step);
    if (!m) throw new ValidationError("Choose a reminder.");
    const loc = shell.location.id;
    const today = clinicToday(shell.location.timezone);
    const input = await loadRetentionInput(shell.clinic, loc, today);
    const rule = input.rules.find((r) => r.id === m[1]);
    const touch = rule?.touches[Number(m[2])];
    if (!rule || !touch) throw new ValidationError("That reminder isn't running at this clinic.");
    const templates = (getVeterinaryPack().retention as unknown as { templates: Record<string, string> }).templates;
    const template = templates[touch.template];
    if (!template) throw new ValidationError("That reminder has no message.");
    const env = getEnv();
    const provider = mailProvider(env);
    if (!provider || !env.EMAIL_FROM) throw new ValidationError("Email is not set up: add RESEND_API_KEY and EMAIL_FROM.");
    const [settings, aiName, clinicRow] = await Promise.all([
      messagingSettings(shell.clinic, loc),
      aiPersonaName(shell.clinic, loc),
      shell.clinic.query<{ main_phone: string | null }>(`SELECT main_phone FROM locations WHERE id = $1`, [loc]),
    ]);
    const phone = clinicRow.rows[0]?.main_phone;
    const body = fillScript(template, {
      ...SAMPLE,
      clinic_name: settings.clinicName,
      ai_name: aiName,
      clinic_phone: phone ? safeFormat(phone) : "the clinic",
      booking_link: `${bookingLinkBase(shell.organization.organization_slug)}/(personal link)`,
    })
      .replace(/\s*Reply STOP to opt out\.?/i, "")
      .trim();
    const subject = `[TEST] A reminder from ${settings.clinicName}`;
    const text = `${body}\n\n--\nThis is a test of the "${rule.name}" reminder. Clients get their own pet's name and a personal booking link.`;

    const testSender = providerTestSender(env);
    let sender: "clinic" | "provider_test" = "clinic";
    const sent: string[] = [];
    const failed: { address: string; status: number }[] = [];
    for (const address of to) {
      let r = await sendEmail({ provider, from: env.EMAIL_FROM, fromName: settings.clinicName }, { to: address, subject, text }).catch(() => ({ ok: false, id: null, status: 0 }));
      if (!r.ok && r.status === 403 && provider.kind === "resend" && testSender) {
        sender = "provider_test";
        r = await sendEmail({ provider, from: testSender, fromName: settings.clinicName }, { to: address, subject, text }).catch(() => ({ ok: false, id: null, status: 0 }));
      }
      if (r.ok) sent.push(address);
      else failed.push({ address, status: r.status });
    }
    await logReminderTestSend(shell.clinic, { locationId: loc, actor, step, to, ok: failed.length === 0, sender });
    if (sent.length === 0) {
      return {
        ok: false,
        error: failed.some((f) => f.status === 403)
          ? "The email provider refused it: the sending domain isn't verified yet, and its test sender only delivers to the provider account's own address."
          : "The test reminder could not be sent. Check the email settings and try again.",
      };
    }
    const note = sender === "provider_test" ? " (from the email provider's test sender, because your sending domain isn't verified yet)" : "";
    const partly = failed.length ? ` Not sent to ${failed.map((f) => f.address).join(", ")}.` : "";
    return { ok: true, message: `Test reminder sent to ${sent.join(", ")}${note}. Check the inbox (and spam).${partly}` };
  } catch (error) {
    if (error instanceof ValidationError) return { ok: false, error: error.userMessage };
    logger.error("test reminder failed", { error });
    return { ok: false, error: "The test reminder could not be sent. Please try again." };
  }
}
