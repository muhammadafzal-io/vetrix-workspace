// The AI behind the front desk. With OPENAI_API_KEY set:
// - triage asks the OpenAI text model and merges its answer with the pack
//   phrase rules (the higher level wins);
// - conversations use the model to read the owner's words for the engine and
//   to word the engine's replies (conversation-ai.ts; facts are checked).
// Without a key, the scripted sandbox AI answers. No code change either way.
import "server-only";
import {
  acceptRewrite,
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
        }),
      });
      if (!res.ok) {
        log.warn("triage model call failed; using phrase rules", { status: res.status });
        return phrases;
      }
      const body = (await res.json()) as { choices?: { message?: { content?: string; refusal?: string } }[] };
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
  what: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown> | null> {
  try {
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
        response_format: { type: "json_schema", json_schema: { name: schema.name, strict: true, schema: schema.schema } },
      }),
    });
    if (!res.ok) {
      log.warn(`${what} model call failed; using the script`, { status: res.status });
      return null;
    }
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
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
