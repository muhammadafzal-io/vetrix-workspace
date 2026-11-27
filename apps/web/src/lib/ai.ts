// The AI behind the front desk. With OPENAI_API_KEY set:
// - triage asks the OpenAI text model and merges its answer with the pack
//   phrase rules (the higher level wins);
// - conversations use the model to read the owner's words for the engine and
//   to word the engine's replies (conversation-ai.ts; facts are checked).
// Without a key, the scripted sandbox AI answers. No code change either way.
import "server-only";
import {
  acceptParsedPrescription,
  acceptTidiedNote,
  buildPrescriptionParsePrompt,
  buildTidyNotePrompt,
  PRESCRIPTION_PARSE_SCHEMA,
  sandboxParsePrescription,
  TIDY_NOTE_SCHEMA,
  type ParsedPrescription,
  type VisitEntryKind,
  acceptRewrite,
  buildCampaignPlanPrompt,
  buildCampaignPrompt,
  CAMPAIGN_DRAFT_SCHEMA,
  CAMPAIGN_PLAN_SCHEMA,
  parseCampaignPlan,
  sandboxCampaignPlan,
  type CampaignPlan,
  type CampaignPlanOptions,
  checkCampaignCopy,
  parseCampaignDraft,
  sandboxCampaignDraft,
  type CampaignDraft,
  type CampaignDraftRequest,
  type CopyIssue,
  buildRewritePrompt,
  buildTriagePrompt,
  buildUnderstandPrompt,
  REWRITE_SCHEMA,
  UNDERSTAND_SCHEMA,
  type ConversationAI,
  classifyByPhrases,
  mergeAssessments,
  parseTriageAnswer,
  TRIAGE_ANSWER_SCHEMA,
  type TriageRules,
  trace,
} from "@vetrix/domain";
import { sandboxClassifier, type TriageClassifier } from "@vetrix/db/runtime";
import { getVeterinaryPack } from "@vetrix/pack";
import { getEnv, type Env } from "./env";
import { logger, type Logger } from "./logger";

export type AiMode = "openai" | "sandbox";

export function aiMode(env: Pick<Env, "OPENAI_API_KEY" | "OPENAI_TEXT_MODEL"> = getEnv()): AiMode {
  return env.OPENAI_API_KEY && env.OPENAI_TEXT_MODEL ? "openai" : "sandbox";
}

/** A slow model must not leave a caller waiting: fall back to the phrase rules. */
const TIMEOUT_MS = 6000;

/**
 * Prompt caching: OpenAI bills the identical start of a prompt (1,024 tokens
 * or more) at a discount. The key groups calls of one kind so they reach the
 * same cache. It names the call type only, never a clinic or a client.
 */
export const PROMPT_CACHE_KEY = {
  triage: "vetrix-triage",
  understand: "vetrix-understand",
  rewrite: "vetrix-rewrite",
  campaign: "vetrix-campaign",
  plan: "vetrix-campaign-plan",
  tidy: "vetrix-visit-tidy",
  rx: "vetrix-visit-rx",
} as const;

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

/** Token counts per call, so the cache saving can be checked. Numbers only. */
function logUsage(log: Logger, what: string, usage: Usage | undefined): void {
  if (!usage) return;
  trace(
    "ai",
    `lib/ai.ts › ${what}`,
    `← OpenAI answered: ${usage.prompt_tokens ?? 0} input tokens (${usage.prompt_tokens_details?.cached_tokens ?? 0} cached), ${usage.completion_tokens ?? 0} output`,
  );
  log.info("ai usage", {
    call: what,
    input: usage.prompt_tokens ?? 0,
    cached: usage.prompt_tokens_details?.cached_tokens ?? 0,
    output: usage.completion_tokens ?? 0,
  });
}

export function createOpenAiClassifier(
  config: { apiKey: string; model: string },
  log: Logger,
  fetchImpl: typeof fetch = fetch,
): TriageClassifier {
  const rules = getVeterinaryPack().triage as unknown as TriageRules;
  return async (text, petNames) => {
    const phrases = classifyByPhrases(rules, text, { petNames });
    const prompt = buildTriagePrompt(rules, text, petNames);
    try {
      trace("ai", "lib/ai.ts › triage", `→ POST api.openai.com (model ${config.model}, ${TIMEOUT_MS / 1000} s limit; phrase rules already ran)`);
      const res = await fetchImpl("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
          response_format: { type: "json_schema", json_schema: { name: "triage", strict: true, schema: TRIAGE_ANSWER_SCHEMA } },
          prompt_cache_key: PROMPT_CACHE_KEY.triage,
        }),
      });
      if (!res.ok) {
        log.warn("triage model call failed; using phrase rules", { status: res.status });
        return phrases;
      }
      const body = (await res.json()) as { choices?: { message?: { content?: string; refusal?: string } }[]; usage?: Usage };
      logUsage(log, "triage", body.usage);
      const content = body.choices?.[0]?.message?.content;
      // A refusal or empty answer is "unsure": parseTriageAnswer escalates it.
      return mergeAssessments(phrases, parseTriageAnswer(rules, content ?? ""));
    } catch (error) {
      log.warn("triage model unavailable; using phrase rules", { error: (error as Error).name });
      return phrases;
    }
  };
}

let cached: TriageClassifier | undefined;

/** The classifier for this server: OpenAI when configured, otherwise the sandbox AI. */
export function triageClassifier(): TriageClassifier {
  if (cached) return cached;
  const env = getEnv();
  cached =
    aiMode(env) === "openai"
      ? createOpenAiClassifier({ apiKey: env.OPENAI_API_KEY!, model: env.OPENAI_TEXT_MODEL! }, logger)
      : sandboxClassifier;
  return cached;
}

/** A short JSON call to the text model; null on any failure (the caller falls back). */
async function askJson(
  config: { apiKey: string; model: string },
  prompt: { system: string; user: string },
  schema: { name: string; schema: object },
  log: Logger,
  what: "understand" | "rewrite" | "campaign" | "plan" | "tidy" | "rx",
  fetchImpl: typeof fetch,
  timeoutMs = TIMEOUT_MS,
): Promise<Record<string, unknown> | null> {
  try {
    trace("ai", `lib/ai.ts › ${what}`, `→ POST api.openai.com (model ${config.model}, ${timeoutMs / 1000} s limit)`);
    const res = await fetchImpl("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        response_format: { type: "json_schema", json_schema: { name: schema.name, strict: true, schema: schema.schema } },
        prompt_cache_key: PROMPT_CACHE_KEY[what],
      }),
    });
    if (!res.ok) {
      log.warn(`${what} model call failed; using the script`, { status: res.status });
      return null;
    }
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: Usage };
    logUsage(log, what, body.usage);
    const content = body.choices?.[0]?.message?.content;
    return content ? (JSON.parse(content) as Record<string, unknown>) : null;
  } catch (error) {
    log.warn(`${what} model unavailable; using the script`, { error: (error as Error).name });
    return null;
  }
}

export function createOpenAiConversation(config: { apiKey: string; model: string }, log: Logger, fetchImpl: typeof fetch = fetch): ConversationAI {
  return {
    async understand(req) {
      const answer = await askJson(config, buildUnderstandPrompt(req), { name: "understand", schema: UNDERSTAND_SCHEMA }, log, "understand", fetchImpl);
      return typeof answer?.text === "string" ? answer.text : null;
    },
    async rewrite(req) {
      const answer = await askJson(config, buildRewritePrompt(req), { name: "reply", schema: REWRITE_SCHEMA }, log, "rewrite", fetchImpl);
      const reply = typeof answer?.reply === "string" ? answer.reply : null;
      const accepted = acceptRewrite(req, reply);
      if (reply && !accepted) log.info("rewrite dropped a fact; using the script");
      return accepted;
    },
  };
}

let cachedConversation: ConversationAI | null | undefined;

/** The conversation model for this server, or undefined in Sandbox AI mode. */
export function conversationAI(): ConversationAI | undefined {
  if (cachedConversation === undefined) {
    const env = getEnv();
    cachedConversation = aiMode(env) === "openai" ? createOpenAiConversation({ apiKey: env.OPENAI_API_KEY!, model: env.OPENAI_TEXT_MODEL! }, logger) : null;
  }
  return cachedConversation ?? undefined;
}

// ---------- Campaign drafts ----------

/** Staff wait for a campaign draft on screen, so it may take longer than a call turn. */
const CAMPAIGN_TIMEOUT_MS = 20_000;

export interface CampaignDraftResult {
  draft: CampaignDraft;
  /** "ai": written by the model; "sandbox": the scripted draft (no key, or the model failed). */
  source: "ai" | "sandbox";
  /** Problems the copy check still finds (staff fix them before approving). */
  issues: { sms: CopyIssue[]; email: CopyIssue[] };
}

function issuesOf(draft: CampaignDraft, facts: string, forbidden: readonly string[], kind: CampaignDraftRequest["kind"]) {
  return {
    sms: draft.sms !== undefined ? checkCampaignCopy({ channel: "sms", body: draft.sms, kind }, facts, forbidden) : [],
    email: draft.emailBody !== undefined ? checkCampaignCopy({ channel: "email", subject: draft.emailSubject, body: draft.emailBody, kind }, facts, forbidden) : [],
  };
}

/**
 * Writes a campaign's text and email. With an OpenAI key the model drafts
 * it; if the copy check finds invented facts or promises, the model gets one
 * more try with the problems listed. Without a key (or if the model fails),
 * the scripted sandbox draft is used. Staff always review and approve.
 */
export async function draftCampaign(req: CampaignDraftRequest, facts: string, forbidden: readonly string[], fetchImpl: typeof fetch = fetch): Promise<CampaignDraftResult> {
  const env = getEnv();
  const sandbox = (): CampaignDraftResult => {
    const draft = sandboxCampaignDraft(req);
    return { draft, source: "sandbox", issues: issuesOf(draft, facts, forbidden, req.kind) };
  };
  if (aiMode(env) !== "openai") return sandbox();
  const config = { apiKey: env.OPENAI_API_KEY!, model: env.OPENAI_TEXT_MODEL! };
  let fix: CopyIssue[] | undefined;
  let last: CampaignDraftResult | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = await askJson(config, buildCampaignPrompt({ ...req, fix }), { name: "campaign", schema: CAMPAIGN_DRAFT_SCHEMA }, logger, "campaign", fetchImpl, CAMPAIGN_TIMEOUT_MS);
    const draft = parseCampaignDraft(answer ? JSON.stringify(answer) : null, req.channels);
    if (!draft) break;
    const issues = issuesOf(draft, facts, forbidden, req.kind);
    last = { draft, source: "ai", issues };
    if (issues.sms.length === 0 && issues.email.length === 0) return last;
    fix = [...issues.sms, ...issues.email];
    logger.info("campaign draft failed the copy check; asking again", { issues: fix.length });
  }
  return last ?? sandbox();
}

/**
 * Turns one staff request into a campaign plan: name, channels and audience
 * rules (checked by validateAudience). With no AI key, or an answer that does
 * not pass the checks, the keyword-based sandbox plan is used.
 */
export async function planCampaign(request: string, options: CampaignPlanOptions, fetchImpl: typeof fetch = fetch): Promise<{ plan: CampaignPlan; source: "ai" | "sandbox" }> {
  const env = getEnv();
  if (aiMode(env) === "openai") {
    const answer = await askJson(
      { apiKey: env.OPENAI_API_KEY!, model: env.OPENAI_TEXT_MODEL! },
      buildCampaignPlanPrompt(request, options),
      { name: "campaign_plan", schema: CAMPAIGN_PLAN_SCHEMA },
      logger,
      "plan",
      fetchImpl,
      CAMPAIGN_TIMEOUT_MS,
    );
    const plan = parseCampaignPlan(answer, options);
    if (plan) return { plan, source: "ai" };
    if (answer) logger.info("campaign plan from the model did not pass the checks; using the sandbox plan");
  }
  return { plan: sandboxCampaignPlan(request, options), source: "sandbox" };
}

// ---------- Visit records (staff only) ----------

/** Staff wait on screen for these, like campaign drafts. */
const VISIT_AI_TIMEOUT_MS = 15_000;

/**
 * Tidies a rough note or recommendation. Only the typed text and the species
 * are sent. A draft that adds a number, a medicine-like word or a diagnosis
 * is thrown away (acceptTidiedNote). Null without a key or a usable draft:
 * staff keep their own text.
 */
export async function tidyVisitNote(input: { kind: VisitEntryKind; text: string; species: string }, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const env = getEnv();
  if (aiMode(env) !== "openai") return null;
  const config = { apiKey: env.OPENAI_API_KEY!, model: env.OPENAI_TEXT_MODEL! };
  const answer = await askJson(config, buildTidyNotePrompt(input), { name: "tidy_note", schema: TIDY_NOTE_SCHEMA }, logger, "tidy", fetchImpl, VISIT_AI_TIMEOUT_MS);
  const accepted = acceptTidiedNote(input.text, answer?.text);
  if (answer && !accepted) logger.info("tidied note added something that was not typed; not shown");
  return accepted?.text ?? null;
}

/**
 * Reads a typed prescription line into the form's fields. With a key the
 * model reads it (each field checked against the text); without one, or if
 * the model fails, fixed rules read common shorthand ("Sandbox").
 */
export async function readPrescriptionLine(text: string, fetchImpl: typeof fetch = fetch): Promise<{ fields: ParsedPrescription; source: "ai" | "sandbox" } | null> {
  const env = getEnv();
  if (aiMode(env) === "openai") {
    const config = { apiKey: env.OPENAI_API_KEY!, model: env.OPENAI_TEXT_MODEL! };
    const answer = await askJson(config, buildPrescriptionParsePrompt(text), { name: "prescription", schema: PRESCRIPTION_PARSE_SCHEMA }, logger, "rx", fetchImpl, VISIT_AI_TIMEOUT_MS);
    const fields = acceptParsedPrescription(text, answer);
    if (fields) return { fields, source: "ai" };
  }
  const fields = sandboxParsePrescription(text);
  return fields ? { fields, source: "sandbox" } : null;
}
