// A language model in the front desk conversation, in two narrow roles.
// The engine (front-desk.ts) still decides everything: who the caller is,
// which visit, which times, what gets booked, and all triage actions.
//
// 1. Understand: before the engine reads a message, the model restates it in
//    the plain form the engine's parsers expect for the current step
//    ("the second one" -> "the second one", "nah not that day" -> "no",
//    "she's about five" -> "5 years"). Triage always reads the original words.
// 2. Word: after the engine decides its reply, the model rewrites the
//    scripted text so it reads naturally. Every time, date, price, phone
//    number, link and name in the script must survive word for word, or the
//    script is used. Emergency turns are never rewritten.
// Pure, so it can be tested without a network; a failure anywhere means the
// scripted engine answers as before.
import type { ConversationState, FrontDeskContext } from "./front-desk";
import { isNo, isYes, openTimeValue, slotLabel } from "./front-desk-language";
import { localParts } from "./time";

export interface UnderstandRequest {
  /** What the caller just said. */
  text: string;
  /** What the engine is waiting for, in plain words. */
  expecting: string;
  /** True when the engine reads many details from one message (the open question). */
  open: boolean;
  /** For focused steps: the only answers allowed (UNCLEAR means "use the owner's words"). */
  forms?: string[];
  aiName: string;
  clinicName: string;
}

export interface RewriteRequest {
  replies: string[];
  /** Exact strings the rewrite must keep. */
  keep: string[];
  aiName: string;
  clinicName: string;
  channel: "voice" | "sms";
  /** The caller's last message, for tone only. */
  callerText: string;
}

/** Implemented by the web app with OpenAI; absent in Sandbox AI mode. */
export interface ConversationAI {
  understand(req: UnderstandRequest): Promise<string | null>;
  rewrite(req: RewriteRequest): Promise<string | null>;
}

// ---------- Understanding ----------

export const UNDERSTAND_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: { text: { type: "string", description: "The caller's message restated plainly, or exactly as given when no restatement helps." } },
} as const;

const QUESTION_FORMS: Record<string, string> = {
  first_name: 'Their name, as "My name is <First> <Last>".',
  last_name: 'Their last name, as "My name is <Last>".',
  mobile_confirm: "Whether the number we have is right.",
  mobile: "Their mobile number, digits only.",
  email: 'Their email address only, or "no email".',
  sms_consent: "Whether we may text them about appointments.",
  pet_name: 'The pet\'s name, as "Her name is <Name>" (or "His name is").',
  species: "The kind of pet.",
  breed: 'The breed, or "not sure".',
  age: 'The age as "<n> years" or "<n> months", or "not sure".',
  sex: "Whether the pet is male or female.",
  neutered: "Whether the pet is spayed or neutered.",
  referring_clinic: 'The name of their previous clinic, or "no".',
  which_pets: "The names of the pets they mean, separated by commas.",
};

/** Answer for "this message doesn't fit the allowed answers": the engine reads the owner's own words. */
export const UNCLEAR = "unclear";
const YES_NO = ["yes", "no", UNCLEAR];
const QUESTION_CHOICES: Record<string, string[]> = {
  mobile_confirm: YES_NO,
  sms_consent: YES_NO,
  species: ["dog", "cat", "rabbit", "bird", "reptile", "other", UNCLEAR],
  sex: ["male", "female", "not sure", UNCLEAR],
  neutered: ["yes", "no", "not sure", UNCLEAR],
};
const OFFER_CHOICES = ["the first one", "the second one", "none of those", UNCLEAR];

/** What the engine is waiting for, in words the model can act on. */
export function describeExpectation(s: ConversationState, ctx: FrontDeskContext): { expecting: string; open: boolean; forms?: string[] } {
  const pets = s.pets.filter((p) => p.status === "active").map((p) => p.name);
  // The clinic's own words for reasons, so slang ("jabs", "booster shot") maps to what the engine knows.
  const words = [...new Set(ctx.intake.keyword_to_service.flatMap((r) => r.keywords.slice(0, 3)).filter(Boolean))].slice(0, 90);
  const vocabulary = words.length ? ` For the reason, use the closest of these words when one fits: ${words.map((w) => `"${w}"`).join(", ")}.` : "";
  const label = (start: number) => slotLabel(start, ctx.timezone, ctx.now);
  switch (s.phase) {
    case "offering": {
      const options = s.offeredGroups.length ? s.offeredGroups.map((g) => label(g[0]!.start)) : s.offered.map((o) => label(o.start));
      return {
        expecting: `Choosing between the times offered: ${options.map((o, i) => `${i === 0 ? "first" : "second"} = ${o}`).join("; ")}. "none of those" when they turn the offered times down. "${UNCLEAR}" when they ask for a different day or time, ask a question, or anything else.`,
        open: false,
        forms: OFFER_CHOICES,
      };
    }
    case "question":
      return { expecting: QUESTION_FORMS[s.question ?? ""] ?? "An answer to the question just asked.", open: false, forms: QUESTION_CHOICES[s.question ?? ""] };
    case "verify":
      return { expecting: `To confirm who they are, the name of one of their pets${pets.length ? ` (on file: ${pets.join(", ")})` : ""}. Answer with the pet's name only.`, open: false };
    case "ask_pet":
      return { expecting: `Which pet the visit is for${pets.length ? ` (${pets.join(", ")})` : ""}, or that it is a new pet. Answer with the name(s), or "a new pet".`, open: false };
    case "confirm_new_pet":
    case "confirm_deceased":
    case "rebook":
      return { expecting: "A yes or no to the question just asked.", open: false, forms: YES_NO };
    case "ask_service":
    case "unclear_service":
      return {
        expecting:
          `The reason for the visit in plain words: e.g. "annual checkup", "vaccines", "nail trim", "recheck", "sick: vomiting since yesterday", "limping". Keep any symptom words they used.${vocabulary}`,
        open: false,
      };
    default:
      return {
        expecting: `What they want. Add a plain restatement such as "I want to book a visit for <pet> for <reason> on <day/time>", "I need to reschedule my appointment", "cancel my appointment", "I need a prescription refill for <medicine>", "what are your opening hours", "I want to speak to a person", or "that's all, goodbye". Keep every pet name, reason, symptom, day and time they mentioned. If they say a pet has died, keep those words.${vocabulary}${pets.length ? ` Their pets: ${pets.join(", ")}.` : ""}`,
        open: true,
      };
  }
}

export function buildUnderstandPrompt(req: UnderstandRequest): { system: string; user: string } {
  const system = [
    `You help ${req.aiName}, the front desk at ${req.clinicName}, a veterinary clinic, read what a pet owner wrote. A strict parser reads your output, not a person.`,
    `Restate the owner's message in the plain form described below. Never add facts they did not give. Never answer the owner. Never give medical advice.`,
    `If the message does not answer this step (a question, a change of topic, a complaint), return it unchanged.`,
    `Expected: ${req.expecting}`,
    req.forms ? `Answer with exactly one of: ${req.forms.map((f) => `"${f}"`).join(", ")}. Use "${UNCLEAR}" whenever you are not sure.` : "",
    'Reply as JSON: {"text": "..."}',
  ]
    .filter(Boolean)
    .join("\n");
  return { system, user: req.text };
}

/**
 * The text the engine reads: the restatement, added to (open step) or in place
 * of the original. On focused steps only an allowed answer is used, and never
 * one that contradicts a plain "no" from the owner (a model must not turn
 * "neither" into a booking).
 */
export function engineText(original: string, restated: string | null, open: boolean, forms?: string[]): string {
  const r = restated?.trim();
  if (!r || r.length > 400 || r.toLowerCase() === original.trim().toLowerCase()) return original;
  if (open) return `${original}\n${r}`;
  if (!forms) return r;
  const answer = r.toLowerCase().replace(/^["']|["'.!]+$/g, "").trim();
  if (!forms.includes(answer) || answer === UNCLEAR) return original;
  // A plain "no" from the owner is read from their own words, which may also name a day or time.
  if (isNo(original) && !isYes(original)) return original;
  return answer;
}

// ---------- Wording ----------

export const REWRITE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply"],
  properties: { reply: { type: "string" } },
} as const;

const TIME = /\b\d{1,2}(?::\d{2})?\s?(?:AM|PM)\b/g;
const MONEY = /\$\s?\d[\d,]*(?:\.\d{2})?/g;
const PHONE = /(?:\+1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const URL = /https?:\/\/\S+/g;
const DATE = /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|today|tomorrow)\b(?:,\s(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s\d{1,2})?/g;

/** The exact strings a rewrite must keep: times, days, prices, phone numbers, links and known names. */
export function mustKeep(replies: string[], names: string[]): string[] {
  const text = replies.join(" ");
  const found = new Set<string>();
  for (const re of [TIME, MONEY, PHONE, URL, DATE]) for (const m of text.matchAll(re)) found.add(m[0].replace(/[.,;:!?)]+$/, ""));
  for (const n of names) if (n && text.includes(n)) found.add(n);
  return [...found];
}

export function buildRewritePrompt(req: RewriteRequest): { system: string; user: string } {
  const system = [
    `You are ${req.aiName}, the warm, efficient front desk at ${req.clinicName}, a veterinary clinic. Rewrite the draft reply below into one natural ${req.channel === "voice" ? "spoken" : "text message"} reply.`,
    "Keep every fact, question and instruction. Do not add information, promises, prices, times, medical advice or questions that are not in the draft.",
    `These must appear exactly as written: ${req.keep.length ? req.keep.map((k) => `"${k}"`).join(", ") : "(none)"}.`,
    req.channel === "voice" ? "Short sentences that are easy to hear. No lists, no emojis." : "Plain text, friendly and brief. No emojis, no markdown.",
    "If the draft ends with a question, end with that question.",
    'Reply as JSON: {"reply": "..."}',
  ].join("\n");
  return { system, user: `Owner said: ${req.callerText}\n\nDraft reply:\n${req.replies.join("\n")}` };
}

/** A rewrite is used only if it keeps everything that matters and stays a reasonable length. */
export function acceptRewrite(req: RewriteRequest, rewritten: string | null): string | null {
  const r = rewritten?.trim();
  if (!r) return null;
  const draft = req.replies.join(" ");
  if (r.length > Math.max(320, draft.length * 1.6)) return null;
  if (!req.keep.every((k) => r.includes(k))) return null;
  // Nothing new that looks like a fact: no times, prices, numbers or links the draft did not have.
  for (const re of [TIME, MONEY, PHONE, URL]) for (const m of r.matchAll(re)) if (!draft.includes(m[0].replace(/[.,;:!?)]+$/, ""))) return null;
  if (draft.trim().endsWith("?") && !r.endsWith("?")) return null;
  return r;
}

// ---------- Tappable answers in the website chat ----------

export interface ChatChoice {
  /** What the button says. */
  label: string;
  /** What is sent when tapped (words the engine already understands). */
  value: string;
  /** A time from the full list: its clinic day ("2026-11-28"), day label and doctor. */
  time?: { date: string; day: string; doctor: string | null };
}

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Every free time with each doctor, for the time picker (the two spoken ones come first as quick answers). */
export function openTimeChoices(s: ConversationState, ctx: FrontDeskContext): ChatChoice[] {
  const today = localParts(ctx.now, ctx.timezone).date;
  const tomorrow = localParts(ctx.now + 86_400_000, ctx.timezone).date;
  return (s.openTimes ?? []).map((o) => {
    const p = localParts(o.start, ctx.timezone);
    const [, mm, dd] = p.date.split("-").map(Number);
    const day = p.date === today ? "Today" : p.date === tomorrow ? "Tomorrow" : `${DAY_SHORT[p.weekday]} ${MONTH_SHORT[mm! - 1]} ${dd}`;
    const h24 = Math.floor(p.minutes / 60);
    const min = p.minutes % 60;
    const time = `${h24 % 12 === 0 ? 12 : h24 % 12}:${String(min).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
    return { label: time, value: openTimeValue(o, ctx.timezone, ctx.now), time: { date: p.date, day, doctor: o.providerName ?? null } };
  });
}

const COMMON_REASONS: ChatChoice[] = [
  { label: "Annual checkup", value: "annual checkup" },
  { label: "Vaccines", value: "vaccines" },
  { label: "Not feeling well", value: "sick visit" },
  { label: "Nail trim", value: "nail trim" },
];

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Buttons for what the front desk is waiting for, so a website visitor can
 * tap instead of type: the times offered, yes/no, which pet, the reason, or
 * a fixed answer such as the species. Never while it checks who the caller
 * is (pet names would give the answer away) and never during an emergency.
 * Tapping sends words the engine already reads, so nothing else changes.
 */
export function chatChoices(s: ConversationState, ctx: FrontDeskContext): ChatChoice[] {
  if (s.triage.level === "emergency") return [];
  const label = (start: number) => sentence(slotLabel(start, ctx.timezone, ctx.now));
  switch (s.phase) {
    case "offering": {
      const starts = s.offeredGroups.length ? s.offeredGroups.map((g) => g[0]!.start) : s.offered.map((o) => o.start);
      return [
        ...starts.slice(0, 2).map((start, i) => ({ label: label(start), value: i === 0 ? "the first one" : "the second one" })),
        { label: "Other times", value: "none of those" },
        ...openTimeChoices(s, ctx),
      ];
    }
    case "confirm_new_pet":
    case "confirm_deceased":
    case "rebook":
      return [
        { label: "Yes", value: "yes" },
        { label: "No", value: "no" },
      ];
    case "ask_pet": {
      const pets = s.pets.filter((p) => p.status === "active").map((p) => p.name);
      return [...pets.map((p) => ({ label: p, value: p })), { label: "A new pet", value: "a new pet" }];
    }
    case "ask_service":
    case "unclear_service":
      return COMMON_REASONS;
    case "question": {
      const forms = QUESTION_CHOICES[s.question ?? ""];
      return forms ? forms.filter((f) => f !== UNCLEAR).map((f) => ({ label: sentence(f), value: f })) : [];
    }
    default:
      return []; // open questions and identity checks are typed
  }
}
