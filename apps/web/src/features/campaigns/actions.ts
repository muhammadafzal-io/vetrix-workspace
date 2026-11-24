"use server";

// Campaign server actions. Every one needs campaigns.manage at the active
// location (Owner and Practice manager). Rules live in @vetrix/domain and
// @vetrix/db; these only check permission, read the form and refresh pages.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { describeAudience, ForbiddenError, isQuietHours, localParts, validateAudience, validateCampaignRequest, ValidationError, zonedInstant, type Audience, type CampaignChannel, type CopyIssue } from "@vetrix/domain";
import {
  approveCampaign,
  audienceOptions,
  campaignFacts,
  cancelCampaign,
  createCampaign,
  forbiddenCampaignTerms,
  getCampaign,
  previewAudience,
  messagingSettings,
  queuedMessages,
  reopenCampaign,
  runDueCampaigns,
  saveCampaignAudience,
  saveCampaignContent,
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
      const newId = await createCampaign(tx, { locationId: loc, basics: { name: plan.name, goal: request, channels: plan.channels }, actor });
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
    const preview = await previewAudience(shell.clinic, {
      locationId: shell.location.id,
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
    const result = await draftCampaign({ goal: c.goal, clinicName, clinicFacts: facts, channels: c.channels, audienceSummary: audienceSummary.slice(0, 300) }, facts, forbiddenCampaignTerms());
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
      if (!sandbox) await deliverQueued({ clinic: shell.clinic, organizationId: shell.organization.organization_id, locationId: loc, clinicName: ms.clinicName, messages: await queuedMessages(shell.clinic, loc) });
      refresh(id);
      revalidatePath("/messages");
      return {
        ok: true,
        message: r.finished
          ? `Done: ${r.sent} message${r.sent === 1 ? "" : "s"} ${sandbox ? "saved (Sandbox: not sent)" : "sent"}, ${r.skipped} skipped.`
          : `${r.sent} message${r.sent === 1 ? "" : "s"} ${sandbox ? "saved" : "sent"} so far. The rest go out over the next few minutes${isQuietHours(here.minutes, ms.quietStart, ms.quietEnd) ? " (texts after quiet hours)" : ""}.`,
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

