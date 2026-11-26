"use server";

// Campaign server actions. Every one needs campaigns.manage at the active
// location (Owner and Practice manager). Rules live in @vetrix/domain and
// @vetrix/db; these only check permission, read the form and refresh pages.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  describeAudience,
  fillCampaignMessage,
  ForbiddenError,
  isQuietHours,
  localParts,
  parseTestRecipients,
  TEST_SAMPLE,
  validateAudience,
  validateCampaignRequest,
  validateChosenRecipients,
  ValidationError,
  zonedInstant,
  type Audience, type CampaignChannel, type CopyIssue } from "@vetrix/domain";
import {
  approveCampaign,
  audienceOptions,
  campaignFacts,
  cancelCampaign,
  createCampaign,
  forbiddenCampaignTerms,
  getCampaign,
  logCampaignTestSend,
  previewAudience,
  messagingSettings,
  queuedMessages,
  reopenCampaign,
  runDueCampaigns,
  saveCampaignAudience,
  saveCampaignContent,
  saveCampaignRecipients,
  scheduleCampaign,
  updateCampaignBasics,
  validateCampaignBasics,
  withTransaction,
  type Actor,
  type AudiencePreview,
} from "@vetrix/db/runtime";
import { formValues, toActionError, type ActionResult } from "@/lib/action-result";
import { draftCampaign, planCampaign } from "@/lib/ai";
import { logger } from "@/lib/logger";
import { clinicToday } from "@/lib/clinic-date";
import { getEnv, getMessagingMode } from "@/lib/env";
import { deliverQueued } from "@/lib/outbound";
import { mailProvider, sendEmail } from "@/lib/email";
import { createLimiter } from "@/lib/rate-limit";
import { providerTestSender } from "@/lib/allowlist";
import { requireShell } from "@/lib/session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function allowed() {
  const shell = await requireShell();
  if (!shell.permissions.has("campaigns.manage")) throw new ForbiddenError();
  const actor: Actor = { type: "staff", id: shell.access.staffUserId };
  return { shell, actor };
}

function campaignId(id: string) {
  if (!UUID.test(id)) throw new ValidationError("Choose a campaign.");
  return id;
}

const refresh = (id: string) => {
  revalidatePath("/campaigns");
  revalidatePath(`/campaigns/${id}`);
};

export async function createCampaignAction(_: ActionResult | null, f: FormData): Promise<ActionResult> {
  let id: string;
  try {
    const { shell, actor } = await allowed();
    const basics = validateCampaignBasics(formValues(f));
    id = await withTransaction(shell.clinic, (tx) => createCampaign(tx, { locationId: shell.location.id, basics, actor }));
  } catch (error) {
    return { ...toActionError(error), values: formValues(f) } as ActionResult;
  }
  revalidatePath("/campaigns");
  redirect(`/campaigns/${id}`);
}

/**
 * One request in, a whole campaign out: the AI picks the name, channels and
 * audience rules (checked like hand-made rules) and writes the text and
 * email. The request is kept, word for word, as the goal, so the copy check
 * only accepts prices and dates staff wrote. Nothing is sent: staff review
 * the campaign page and approve.
 */
export async function createCampaignWithAiAction(_: ActionResult | null, f: FormData): Promise<ActionResult> {
  let id: string;
  let source: "ai" | "sandbox";
  try {
    const { shell, actor } = await allowed();
    const loc = shell.location.id;
    const request = validateCampaignRequest(f.get("request"));
    const options = await audienceOptions(shell.clinic, loc);
    const built = await planCampaign(request, options);
    source = built.source;
    const { plan } = built;
    id = await withTransaction(shell.clinic, async (tx) => {
      const newId = await createCampaign(tx, { locationId: loc, basics: { kind: "marketing", name: plan.name, goal: request, channels: plan.channels }, actor });
      await saveCampaignAudience(tx, { locationId: loc, id: newId, audience: plan.audience, actor });
      return newId;
    });
    // The messages. If this step fails the campaign still exists; staff use "Write with AI" on its page.
    try {
      const { facts, clinicName } = await campaignFacts(shell.clinic, loc, request);
      const draft = await draftCampaign(
        { goal: request, clinicName, clinicFacts: facts, channels: plan.channels, audienceSummary: describeAudience(plan.audience, options.services) },
        facts,
        forbiddenCampaignTerms(),
      );
      await withTransaction(shell.clinic, async (tx) => {
        if (draft.draft.sms !== undefined) await saveCampaignContent(tx, { locationId: loc, id, channel: "sms", source: "ai", subject: null, body: draft.draft.sms, actor });
        if (draft.draft.emailBody !== undefined) await saveCampaignContent(tx, { locationId: loc, id, channel: "email", source: "ai", subject: draft.draft.emailSubject ?? null, body: draft.draft.emailBody, actor });
      });
    } catch (error) {
      logger.warn("campaign built but its messages were not written", { error: (error as Error).name });
    }
  } catch (error) {
    return { ...toActionError(error), values: formValues(f) } as ActionResult;
  }
  revalidatePath("/campaigns");
  redirect(`/campaigns/${id}?built=${source}`);
}

export async function updateBasicsAction(id: string, _: ActionResult | null, f: FormData): Promise<ActionResult> {
  try {
    const { shell, actor } = await allowed();
    const basics = validateCampaignBasics(formValues(f));
    await withTransaction(shell.clinic, (tx) => updateCampaignBasics(tx, { locationId: shell.location.id, id: campaignId(id), basics, actor }));
  } catch (error) {
    return { ...toActionError(error), values: formValues(f) } as ActionResult;
  }
  refresh(id);
  return { ok: true, message: "Saved." };
}

/** People per page in "See who is included". */
const SAMPLE_PAGE = 20;

export type PreviewResult = { ok: true; preview: AudiencePreview } | { ok: false; error: string };

async function checkedAudience(shell: Awaited<ReturnType<typeof requireShell>>, raw: unknown): Promise<Audience> {
  const options = await audienceOptions(shell.clinic, shell.location.id);
  return validateAudience(raw, { species: options.species, services: options.services.map((s) => s.id) });
}

/** Live count while staff build the rules. Nothing is saved. */
export async function previewAudienceAction(id: string, raw: unknown, channels: CampaignChannel[], sampleOffset = 0): Promise<PreviewResult> {
  try {
    const { shell } = await allowed();
    const audience = await checkedAudience(shell, raw);
    const { kind } = await getCampaign(shell.clinic, shell.location.id, campaignId(id));
    const preview = await previewAudience(shell.clinic, {
      locationId: shell.location.id,
      kind,
      audience,
      channels: channels.filter((c) => c === "sms" || c === "email"),
      today: clinicToday(shell.location.timezone),
      now: Date.now(),
      campaignId: campaignId(id),
      sampleOffset: Number.isInteger(sampleOffset) && sampleOffset >= 0 ? sampleOffset : 0,
      sampleLimit: SAMPLE_PAGE,
    });
    return { ok: true, preview };
  } catch (error) {
    const r = toActionError(error);
    return { ok: false, error: r.ok ? "Something went wrong." : r.error };
  }
}

export async function saveAudienceAction(id: string, raw: unknown): Promise<ActionResult> {
  try {
    const { shell, actor } = await allowed();
    const audience = await checkedAudience(shell, raw);
    await withTransaction(shell.clinic, (tx) => saveCampaignAudience(tx, { locationId: shell.location.id, id: campaignId(id), audience, actor }));
  } catch (error) {
    return toActionError(error);
  }
  refresh(id);
  return { ok: true, message: "Audience saved." };
}

// ---------- Chosen recipients ----------

/** Rows per page in the recipient picker. */
const PICK_PAGE = 25;

/** One page of the clients the saved rules match, optionally searched by name. Nothing is saved. */
export async function recipientChoicesAction(id: string, search: string, offset = 0): Promise<PreviewResult> {
  try {
    const { shell } = await allowed();
    const c = await getCampaign(shell.clinic, shell.location.id, campaignId(id));
    const preview = await previewAudience(shell.clinic, {
      locationId: shell.location.id,
      audience: c.audience,
      channels: c.channels,
      today: clinicToday(shell.location.timezone),
      now: Date.now(),
      campaignId: id,
      recipientIds: c.recipient_ids,
      kind: c.kind,
      search: String(search ?? "").slice(0, 100),
      sampleOffset: Number.isInteger(offset) && offset >= 0 ? offset : 0,
      sampleLimit: PICK_PAGE,
    });
    return { ok: true, preview };
  } catch (error) {
    const r = toActionError(error);
    return { ok: false, error: r.ok ? "Something went wrong." : r.error };
  }
}

/** Everyone who matches ("all"), or only the clients ticked ("chosen"). */
export async function saveRecipientsAction(id: string, mode: "all" | "chosen", clientIds: string[]): Promise<ActionResult> {
  let chosen: number | null;
  try {
    const { shell, actor } = await allowed();
    const ids = validateChosenRecipients(mode, clientIds);
    ({ chosen } = await withTransaction(shell.clinic, (tx) => saveCampaignRecipients(tx, { locationId: shell.location.id, id: campaignId(id), clientIds: ids, actor })));
  } catch (error) {
    return toActionError(error);
  }
  refresh(id);
  return { ok: true, message: chosen === null ? "It goes to everyone who matches." : `Saved: only the ${chosen} client${chosen === 1 ? "" : "s"} you chose.` };
}

export type DraftResult =
  | { ok: true; source: "ai" | "sandbox"; issues: { sms: CopyIssue[]; email: CopyIssue[] } }
  | { ok: false; error: string };

/**
 * Asks the AI (or the sandbox script) for a text and an email, and saves
 * them as new "ai" versions. Staff then edit and approve.
 */
export async function generateDraftAction(id: string, audienceSummary: string): Promise<DraftResult> {
  try {
    const { shell, actor } = await allowed();
    const loc = shell.location.id;
    const c = await getCampaign(shell.clinic, loc, campaignId(id));
    const { facts, clinicName } = await campaignFacts(shell.clinic, loc, c.goal);
    const result = await draftCampaign({ kind: c.kind, goal: c.goal, clinicName, clinicFacts: facts, channels: c.channels, audienceSummary: audienceSummary.slice(0, 300) }, facts, forbiddenCampaignTerms());
    await withTransaction(shell.clinic, async (tx) => {
      if (result.draft.sms !== undefined) await saveCampaignContent(tx, { locationId: loc, id, channel: "sms", source: "ai", subject: null, body: result.draft.sms, actor });
      if (result.draft.emailBody !== undefined) {
        await saveCampaignContent(tx, { locationId: loc, id, channel: "email", source: "ai", subject: result.draft.emailSubject ?? null, body: result.draft.emailBody, actor });
      }
    });
    refresh(id);
    return { ok: true, source: result.source, issues: result.issues };
  } catch (error) {
    const r = toActionError(error);
    return { ok: false, error: r.ok ? "Something went wrong." : r.error };
  }
}

export type ContentResult = { ok: true; issues: CopyIssue[] } | { ok: false; error: string };

/** Saves staff's edited text or email as a new version and returns what the copy check finds. */
export async function saveContentAction(id: string, channel: CampaignChannel, subject: string | null, body: string): Promise<ContentResult> {
  try {
    const { shell, actor } = await allowed();
    if (channel !== "sms" && channel !== "email") throw new ValidationError("Choose text or email.");
    const r = await withTransaction(shell.clinic, (tx) =>
      saveCampaignContent(tx, { locationId: shell.location.id, id: campaignId(id), channel, source: "staff", subject, body: String(body ?? ""), actor }),
    );
    refresh(id);
    return { ok: true, issues: r.issues };
  } catch (error) {
    const r = toActionError(error);
    return { ok: false, error: r.ok ? "Something went wrong." : r.error };
  }
}

export async function approveAction(id: string): Promise<ActionResult> {
  try {
    const { shell, actor } = await allowed();
    await withTransaction(shell.clinic, (tx) => approveCampaign(tx, { locationId: shell.location.id, id: campaignId(id), actor }));
  } catch (error) {
    return toActionError(error);
  }
  refresh(id);
  return { ok: true, message: "Approved. Send it now or choose a time." };
}

/** `when` is "now" or a local date-time from the form (clinic time zone). */
export async function scheduleAction(id: string, when: string): Promise<ActionResult> {
  try {
    const { shell, actor } = await allowed();
    const now = Date.now();
    let sendAt = new Date(now);
    if (when !== "now") {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(when)) throw new ValidationError("Choose a date and time.", { field: "sendAt" });
      sendAt = new Date(zonedInstant(when.slice(0, 10), when.slice(11, 16), shell.location.timezone));
    }
    const loc = shell.location.id;
    await withTransaction(shell.clinic, (tx) => scheduleCampaign(tx, { locationId: loc, id: campaignId(id), sendAt, now, actor }));
    if (when === "now") {
      // The first batch goes out right away (like "Send" on Reminders); the
      // scheduler sends the rest each minute and anything held for quiet hours.
      const ms = await messagingSettings(shell.clinic, loc);
      const here = localParts(now, ms.timezone);
      const sandbox = getMessagingMode() === "sandbox";
      const appUrl = getEnv().APP_URL.replace(/\/$/, "");
      const slug = shell.organization.organization_slug;
      const widget = await shell.clinic.query<{ widget_enabled: boolean; main_phone: string | null }>(`SELECT widget_enabled, main_phone FROM locations WHERE id = $1`, [loc]);
      const { clinicName, clinicPhone } = await campaignFacts(shell.clinic, loc, "");
      const r = await withTransaction(shell.clinic, (tx) =>
        runDueCampaigns(tx, {
          locationId: loc,
          campaignId: id,
          now,
          today: here.date,
          sandbox,
          quietHours: isQuietHours(here.minutes, ms.quietStart, ms.quietEnd),
          values: {
            clinicName,
            clinicPhone: clinicPhone ?? "the clinic",
            bookingUrl: widget.rows[0]?.widget_enabled ? `${appUrl}/w/${slug}` : null,
            unsubscribeBase: `${appUrl}/u/${slug}`,
          },
        }),
      );
      const d = sandbox ? null : await deliverQueued({ clinic: shell.clinic, organizationId: shell.organization.organization_id, locationId: loc, clinicName: ms.clinicName, messages: await queuedMessages(shell.clinic, loc) });
      refresh(id);
      revalidatePath("/messages");
      // Live: say what really happened (sent, failed, kept back by MESSAGING_ALLOWLIST).
      const outcome = d
        ? `${d.sent} sent${d.failed ? `, ${d.failed} failed` : ""}${d.held ? `, ${d.held} kept as simulated (not on MESSAGING_ALLOWLIST)` : ""}`
        : `${r.sent} saved (Sandbox: not sent)`;
      return {
        ok: true,
        message: r.finished
          ? `Done: ${outcome}, ${r.skipped} skipped.`
          : `${outcome} so far. The rest go out over the next few minutes${isQuietHours(here.minutes, ms.quietStart, ms.quietEnd) ? " (texts after quiet hours)" : ""}.`,
      };
    }
  } catch (error) {
    return toActionError(error);
  }
  refresh(id);
  return { ok: true, message: "Scheduled." };
}

export async function reopenAction(id: string): Promise<ActionResult> {
  try {
    const { shell, actor } = await allowed();
    await withTransaction(shell.clinic, (tx) => reopenCampaign(tx, { locationId: shell.location.id, id: campaignId(id), actor }));
  } catch (error) {
    return toActionError(error);
  }
  refresh(id);
  return { ok: true, message: "Back to draft." };
}

export async function cancelAction(id: string): Promise<ActionResult> {
  try {
    const { shell, actor } = await allowed();
    await withTransaction(shell.clinic, (tx) => cancelCampaign(tx, { locationId: shell.location.id, id: campaignId(id), actor }));
  } catch (error) {
    return toActionError(error);
  }
  refresh(id);
  return { ok: true, message: "Campaign stopped. Nothing more will be sent." };
}


// ---------- Test email ----------

const g = globalThis as unknown as { vetrixCampaignTests?: ReturnType<typeof createLimiter> };
/** At most 10 test sends per person per 10 minutes. */
const testLimit = (g.vetrixCampaignTests ??= createLimiter({ limit: 10, windowMs: 10 * 60_000 }));

/**
 * Sends the campaign's latest email to the addresses staff typed, for real,
 * marked [TEST], with sample values (Sam; Bella and Max). Works in sandbox
 * mode too: it is a deliberate test, not a client message. It is not saved as
 * a message and never counts toward the 7-day limit or the results; the
 * audit log keeps who sent it where. Until the clinic's sending domain is
 * verified, development and staging fall back to the email provider's test
 * sender (which only delivers to the provider account's own address).
 */
export async function sendTestEmailAction(id: string, rawTo: string): Promise<ActionResult> {
  try {
    const { shell, actor } = await allowed();
    const to = parseTestRecipients(rawTo);
    if (!testLimit.take(shell.access.staffUserId)) throw new ValidationError("Too many test emails. Try again in a few minutes.");
    const env = getEnv();
    const provider = mailProvider(env);
    if (!provider || !env.EMAIL_FROM) throw new ValidationError("Email is not set up: add RESEND_API_KEY and EMAIL_FROM.");
    const loc = shell.location.id;
    const c = await getCampaign(shell.clinic, loc, campaignId(id));
    const email = c.content.find((x) => x.channel === "email");
    if (!email) throw new ValidationError(c.channels.includes("email") ? "Write the email first (step 3)." : "This campaign doesn't send email.");
    const { clinicName, clinicPhone } = await campaignFacts(shell.clinic, loc, c.goal);
    const widget = await shell.clinic.query<{ widget_enabled: boolean }>(`SELECT widget_enabled FROM locations WHERE id = $1`, [loc]);
    const appUrl = env.APP_URL.replace(/\/$/, "");
    const values = {
      ...TEST_SAMPLE,
      clinic_name: clinicName,
      clinic_phone: clinicPhone ?? "the clinic",
      booking_link: widget.rows[0]?.widget_enabled ? `${appUrl}/w/${shell.organization.organization_slug}` : `call ${clinicPhone ?? "the clinic"}`,
    };
    const subject = `[TEST] ${fillCampaignMessage(email.subject ?? c.name, "email", values)}`;
    const text = `${fillCampaignMessage(email.body, "email", values)}\n\n--\nThis is a test of the campaign "${c.name}" (version ${email.version}). ${c.kind === "marketing" ? "Clients get their own name, their pets' names and a working unsubscribe link." : "Clients get their own name and their pets' names (announcements have no unsubscribe link)."}`;

    // Not production: if the provider refuses the clinic's sender (domain not
    // verified yet), use its test sender so the test can still be seen.
    const testSender = providerTestSender(env);
    let sender: "clinic" | "provider_test" = "clinic";
    const results: { address: string; ok: boolean; status: number }[] = [];
    for (const address of to) {
      let r = await sendEmail({ provider, from: env.EMAIL_FROM, fromName: clinicName }, { to: address, subject, text }).catch(() => ({ ok: false, id: null, status: 0 }));
      if (!r.ok && r.status === 403 && provider.kind === "resend" && testSender) {
        sender = "provider_test";
        r = await sendEmail({ provider, from: testSender, fromName: clinicName }, { to: address, subject, text }).catch(() => ({ ok: false, id: null, status: 0 }));
      }
      results.push({ address, ok: r.ok, status: r.status });
    }
    const sent = results.filter((r) => r.ok).map((r) => r.address);
    const failed = results.filter((r) => !r.ok);
    await logCampaignTestSend(shell.clinic, { locationId: loc, id, actor, to, ok: failed.length === 0, sender });
    if (sent.length === 0) {
      return {
        ok: false,
        error: failed.some((f) => f.status === 403)
          ? "The email provider refused it: the sending domain isn't verified yet, and its test sender only delivers to the provider account's own address."
          : "The test email could not be sent. Check the email settings and try again.",
      };
    }
    const note = sender === "provider_test" ? " (from the email provider's test sender, because your sending domain isn't verified yet)" : "";
    const partly = failed.length ? ` Not sent to ${failed.map((f) => f.address).join(", ")}.` : "";
    return { ok: true, message: `Test email sent to ${sent.join(", ")}${note}. Check the inbox (and spam).${partly}` };
  } catch (error) {
    return toActionError(error);
  }
}
