// Marketing campaigns: who is in the audience, who may receive it on which
// channel, what an AI draft may say, and how a message is filled in for each
// client. Pure functions; the database layer loads the data and saves results.
//
// Decisions (24 Nov 2026): SMS and email only; marketing consent always
// required; at most one campaign message per client per 7 days; audience
// rules are one level (match all or any); one person may approve and send.
import { ValidationError } from "./errors";

export const CAMPAIGN_CHANNELS = ["sms", "email"] as const;
export type CampaignChannel = (typeof CAMPAIGN_CHANNELS)[number];
export type CampaignStatus = "draft" | "approved" | "scheduled" | "sending" | "sent" | "cancelled";

/** A client gets at most one campaign message in this many days. */
export const CAMPAIGN_FREQUENCY_DAYS = 7;
/** Messages created per clinic per scheduler tick (once a minute). */
export const CAMPAIGN_BATCH_SIZE = 200;
export const CAMPAIGN_SMS_MAX = 320;
export const CAMPAIGN_EMAIL_MAX = 3000;
export const MAX_AUDIENCE_CONDITIONS = 8;
/** Added to every campaign text (carrier rules). */
export const SMS_OPT_OUT = "Reply STOP to opt out.";

// ---------- Audience ----------

export type AudienceCondition =
  | { type: "species"; values: string[] }
  | { type: "pet_age"; minYears?: number; maxYears?: number }
  /** The pet's last completed visit was more than / within N months ago ("more_than" includes never). */
  | { type: "last_visit"; op: "more_than" | "within"; months: number }
  /** A vaccine is overdue, or comes due within N days. */
  | { type: "vaccine"; state: "overdue" | "due_within"; days?: number }
  /** The pet has not had this service (pack service id) in N months, or ever. */
  | { type: "service_gap"; service: string; months: number };

export interface Audience {
  match: "all" | "any";
  conditions: AudienceCondition[];
}

export const AUDIENCE_CONDITION_LABEL: Record<AudienceCondition["type"], string> = {
  species: "Species",
  pet_age: "Pet age",
  last_visit: "Last visit",
  vaccine: "Vaccines",
  service_gap: "Has not had a service",
};

const int = (v: unknown, min: number, max: number): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max ? n : null;
};

/** Checks audience rules from a form or the database. `species` and `services` are what this clinic has. */
export function validateAudience(raw: unknown, allowed: { species: readonly string[]; services: readonly string[] }): Audience {
  const a = (raw ?? {}) as { match?: unknown; conditions?: unknown };
  const match = a.match === "any" ? "any" : a.match === "all" ? "all" : null;
  if (!match) throw new ValidationError("Choose whether clients must match all or any of the rules.", { field: "match" });
  if (!Array.isArray(a.conditions)) throw new ValidationError("Add at least one rule.", { field: "conditions" });
  if (a.conditions.length > MAX_AUDIENCE_CONDITIONS) throw new ValidationError(`Use at most ${MAX_AUDIENCE_CONDITIONS} rules.`, { field: "conditions" });
  const conditions = a.conditions.map((c: unknown, i): AudienceCondition => {
    const r = (c ?? {}) as Record<string, unknown>;
    const field = `conditions.${i}`;
    switch (r.type) {
      case "species": {
        const values = [...new Set(Array.isArray(r.values) ? r.values.map(String) : [])];
        if (values.length === 0 || !values.every((v) => allowed.species.includes(v))) throw new ValidationError("Choose at least one species.", { field });
        return { type: "species", values };
      }
      case "pet_age": {
        const minYears = r.minYears === undefined || r.minYears === "" ? undefined : int(r.minYears, 0, 40);
        const maxYears = r.maxYears === undefined || r.maxYears === "" ? undefined : int(r.maxYears, 0, 40);
        if (minYears === null || maxYears === null || (minYears === undefined && maxYears === undefined) || (minYears !== undefined && maxYears !== undefined && minYears > maxYears)) {
          throw new ValidationError("Enter a pet age range in whole years, the lower number first.", { field });
        }
        return { type: "pet_age", ...(minYears !== undefined ? { minYears } : {}), ...(maxYears !== undefined ? { maxYears } : {}) };
      }
      case "last_visit": {
        const months = int(r.months, 1, 120);
        if ((r.op !== "more_than" && r.op !== "within") || months === null) throw new ValidationError("Enter the months since the last visit (1 to 120).", { field });
        return { type: "last_visit", op: r.op, months };
      }
      case "vaccine": {
        if (r.state === "overdue") return { type: "vaccine", state: "overdue" };
        const days = int(r.days, 1, 180);
        if (r.state !== "due_within" || days === null) throw new ValidationError("Enter how many days ahead (1 to 180).", { field });
        return { type: "vaccine", state: "due_within", days };
      }
      case "service_gap": {
        const months = int(r.months, 1, 120);
        if (typeof r.service !== "string" || !allowed.services.includes(r.service) || months === null) throw new ValidationError("Choose a service and the months since it.", { field });
        return { type: "service_gap", service: r.service, months };
      }
      default:
        throw new ValidationError("Choose a kind of rule.", { field });
    }
  });
  if (conditions.length === 0) throw new ValidationError("Add at least one rule, so the campaign does not go to every client by accident.", { field: "conditions" });
  return { match, conditions };
}

/** One active pet, with what the rules look at. Dates are clinic dates (YYYY-MM-DD). */
export interface AudiencePet {
  id: string;
  clientId: string;
  name: string;
  species: string;
  ageYears: number | null;
  lastVisitAt: string | null;
  /** Earliest due date among the pet's current vaccines (latest record per vaccine). */
  nextVaccineDueAt: string | null;
  /** Last completed visit per pack service id. */
  lastServiceAt: Record<string, string>;
}

const DAY = 86_400_000;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
const monthsAgo = (today: string, months: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
};

export function petMatches(c: AudienceCondition, p: AudiencePet, today: string): boolean {
  switch (c.type) {
    case "species":
      return c.values.includes(p.species);
    case "pet_age":
      return p.ageYears !== null && (c.minYears === undefined || p.ageYears >= c.minYears) && (c.maxYears === undefined || p.ageYears < c.maxYears + 1);
    case "last_visit": {
      const cutoff = monthsAgo(today, c.months);
      return c.op === "more_than" ? p.lastVisitAt === null || p.lastVisitAt < cutoff : p.lastVisitAt !== null && p.lastVisitAt >= cutoff;
    }
    case "vaccine":
      if (!p.nextVaccineDueAt) return false;
      return c.state === "overdue" ? p.nextVaccineDueAt < today : p.nextVaccineDueAt >= today && daysBetween(today, p.nextVaccineDueAt) <= (c.days ?? 30);
    case "service_gap": {
      const last = p.lastServiceAt[c.service];
      return !last || last < monthsAgo(today, c.months);
    }
  }
}

/** The pets that match, grouped by client (a client is in the audience through any of their pets). */
export function selectAudience(audience: Audience, pets: AudiencePet[], today: string): Map<string, AudiencePet[]> {
  const out = new Map<string, AudiencePet[]>();
  for (const p of pets) {
    const results = audience.conditions.map((c) => petMatches(c, p, today));
    const ok = audience.match === "all" ? results.every(Boolean) : results.some(Boolean);
    if (ok) (out.get(p.clientId) ?? out.set(p.clientId, []).get(p.clientId)!).push(p);
  }
  return out;
}

/** One sentence for the AI and for people: "Dogs, last visit more than 12 months ago". */
export function describeAudience(a: Audience, services: { id: string; name: string }[]): string {
  const parts = a.conditions.map((c) => {
    switch (c.type) {
      case "species":
        return c.values.map((v) => `${v}s`).join(" or ");
      case "pet_age":
        return c.minYears !== undefined && c.maxYears !== undefined ? `pets ${c.minYears} to ${c.maxYears} years old` : c.minYears !== undefined ? `pets ${c.minYears} years or older` : `pets up to ${c.maxYears} years old`;
      case "last_visit":
        return c.op === "more_than" ? `not seen in ${c.months} months` : `seen in the last ${c.months} months`;
      case "vaccine":
        return c.state === "overdue" ? "a vaccine overdue" : `a vaccine due within ${c.days} days`;
      case "service_gap":
        return `no ${services.find((s) => s.id === c.service)?.name.toLowerCase() ?? c.service} in ${c.months} months`;
    }
  });
  return parts.length ? `Clients whose pets match ${a.match === "all" ? "all" : "any"} of: ${parts.join("; ")}` : "No rules yet";
}

// ---------- Who may receive it ----------

export interface CampaignClient {
  id: string;
  firstName: string;
  marketingConsent: boolean;
  smsConsent: boolean;
  email: string | null;
  flags: string[];
  /** When this client last got a campaign message (any campaign), if ever. */
  lastCampaignAt: Date | null;
}

export type SkipReason = "no_marketing_consent" | "no_sms_consent" | "no_email" | "do_not_contact" | "contacted_recently" | "pet_not_active";

export const SKIP_REASON_LABEL: Record<SkipReason, string> = {
  no_marketing_consent: "No marketing consent",
  no_sms_consent: "No consent to text",
  no_email: "No email address",
  do_not_contact: "Marked do not contact",
  contacted_recently: `Had a campaign message in the last ${CAMPAIGN_FREQUENCY_DAYS} days`,
  pet_not_active: "Pet no longer active",
};

/** Whether this client may get this campaign on this channel now, or why not. */
export function campaignEligibility(client: CampaignClient, channel: CampaignChannel, now: number): SkipReason | null {
  if (client.flags.includes("do_not_contact")) return "do_not_contact";
  if (!client.marketingConsent) return "no_marketing_consent";
  if (channel === "sms" && !client.smsConsent) return "no_sms_consent";
  if (channel === "email" && !client.email) return "no_email";
  if (client.lastCampaignAt && now - client.lastCampaignAt.getTime() < CAMPAIGN_FREQUENCY_DAYS * DAY) return "contacted_recently";
  return null;
}

// ---------- Status ----------

const NEXT: Record<CampaignStatus, CampaignStatus[]> = {
  draft: ["approved", "cancelled"],
  approved: ["draft", "scheduled", "cancelled"],
  scheduled: ["draft", "sending", "cancelled"],
  sending: ["sent", "cancelled"],
  sent: [],
  cancelled: [],
};

export function canChangeCampaign(from: CampaignStatus, to: CampaignStatus): boolean {
  return NEXT[from].includes(to);
}

// ---------- The message ----------

/** Placeholders staff and the AI may use; filled per client when sending. */
export const CAMPAIGN_PLACEHOLDERS = ["client_first_name", "pet_names", "clinic_name", "clinic_phone", "booking_link"] as const;

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g;
const MONEY = /\$\s?\d[\d,]*(?:\.\d{2})?/g;
const PERCENT = /\d+(?:\.\d+)?\s?%/g;
const PHONE = /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const DATE_RE = new RegExp(`\\b(?:(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})|\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?)\\b`, "gi");
/** Promises a clinic must not make in marketing. */
const CLAIMS = /\b(?:guarantee[ds]?|cures?|cured|risk[- ]free|100\s?% (?:safe|effective)|miracle|never get sick|prevents? all)\b/gi;

const squash = (s: string) => s.toLowerCase().replace(/[\s,]/g, "");

export interface CopyIssue {
  kind: "fact" | "placeholder" | "claim" | "term" | "length" | "empty";
  text: string;
}

/**
 * Checks a campaign text or email before it can be approved: every price,
 * percentage, phone number, link and date must come from the staff's goal or
 * the clinic's details (`facts`), only known placeholders, no medical
 * promises or forbidden terms, and within the length for the channel.
 */
export function checkCampaignCopy(
  input: { channel: CampaignChannel; subject?: string | null; body: string },
  facts: string,
  forbiddenTerms: readonly string[] = [],
): CopyIssue[] {
  const issues: CopyIssue[] = [];
  const text = `${input.subject ?? ""}\n${input.body}`;
  if (!input.body.trim()) return [{ kind: "empty", text: "The message is empty." }];
  if (input.channel === "email" && !input.subject?.trim()) issues.push({ kind: "empty", text: "Add an email subject." });
  const source = squash(facts);
  for (const re of [MONEY, PERCENT, PHONE, URL_RE, DATE_RE]) {
    for (const m of text.replace(PLACEHOLDER, " ").matchAll(re)) {
      const found = m[0].replace(/[.,;:!?)]+$/, "");
      if (!source.includes(squash(found))) issues.push({ kind: "fact", text: `"${found}" is not in your goal or clinic details.` });
    }
  }
  for (const m of text.matchAll(PLACEHOLDER)) {
    if (!(CAMPAIGN_PLACEHOLDERS as readonly string[]).includes(m[1]!)) issues.push({ kind: "placeholder", text: `{{${m[1]}}} is not a known placeholder.` });
  }
  for (const m of text.matchAll(CLAIMS)) issues.push({ kind: "claim", text: `"${m[0]}" is a promise the clinic should not make.` });
  const lower = text.toLowerCase();
  for (const t of forbiddenTerms) {
    if (new RegExp(`(?<![\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu").test(lower)) issues.push({ kind: "term", text: `"${t}" cannot be used.` });
  }
  const max = input.channel === "sms" ? CAMPAIGN_SMS_MAX - SMS_OPT_OUT.length - 1 : CAMPAIGN_EMAIL_MAX;
  if (input.body.length > max) issues.push({ kind: "length", text: `Keep it under ${max} characters (now ${input.body.length}).` });
  // One issue per distinct text.
  return [...new Map(issues.map((i) => [i.text, i])).values()];
}

/** The message one client gets: placeholders filled, the STOP line on texts. */
export function fillCampaignMessage(body: string, channel: CampaignChannel, values: Record<(typeof CAMPAIGN_PLACEHOLDERS)[number], string>): string {
  const filled = body.replace(PLACEHOLDER, (_, k: string) => (values as Record<string, string>)[k] ?? "").replace(/[ \t]+\n/g, "\n").replace(/ {2,}/g, " ").trim();
  return channel === "sms" ? `${filled} ${SMS_OPT_OUT}` : filled;
}

/** "Bella", "Bella and Max", "Bella, Max and Coco". */
export function joinPetNames(names: string[]): string {
  const u = [...new Set(names)];
  return u.length <= 1 ? (u[0] ?? "your pet") : `${u.slice(0, -1).join(", ")} and ${u.at(-1)}`;
}

// ---------- AI drafts ----------

export interface CampaignDraftRequest {
  goal: string;
  clinicName: string;
  clinicFacts: string;
  channels: CampaignChannel[];
  audienceSummary: string;
  /** Issues with the previous draft, so the model can fix them. */
  fix?: CopyIssue[];
}

export interface CampaignDraft {
  sms?: string;
  emailSubject?: string;
  emailBody?: string;
}

export const CAMPAIGN_DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sms", "email_subject", "email_body"],
  properties: {
    sms: { type: "string" },
    email_subject: { type: "string" },
    email_body: { type: "string" },
  },
} as const;

export function buildCampaignPrompt(req: CampaignDraftRequest): { system: string; user: string } {
  const system = [
    `You write short, warm marketing messages for ${req.clinicName}, a veterinary clinic, to its existing clients.`,
    "Use only facts from the goal and the clinic details. Do not invent prices, discounts, dates, times, phone numbers, links or services.",
    "No medical claims or promises (no 'guaranteed', 'cures', 'risk-free'). No emojis, no markdown.",
    "Write to one owner about their own pet. Never describe who the campaign targets (no 'this is for dogs over 8 not seen in 6 months').",
    `You may use these placeholders: ${CAMPAIGN_PLACEHOLDERS.map((p) => `{{${p}}}`).join(", ")}. Use {{booking_link}} for booking; never write a link yourself.`,
    `Text message: at most ${CAMPAIGN_SMS_MAX - SMS_OPT_OUT.length - 20} characters, start with the clinic name, do not add an opt-out line (it is added for you).`,
    "Email: a clear subject (under 70 characters) and a body of 2 to 4 short paragraphs, signed by the clinic team. Do not add an unsubscribe line (it is added for you).",
    req.channels.length < 2 ? `Only the ${req.channels[0] === "sms" ? "text message" : "email"} is needed; return an empty string for the other.` : "",
    'Reply as JSON: {"sms": "...", "email_subject": "...", "email_body": "..."}',
  ]
    .filter(Boolean)
    .join("\n");
  const user = [
    `Goal: ${req.goal}`,
    `Who it goes to: ${req.audienceSummary}`,
    `Clinic details: ${req.clinicFacts}`,
    req.fix?.length ? `Fix these problems in your last draft: ${req.fix.map((i) => i.text).join(" ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { system, user };
}

export function parseCampaignDraft(raw: string | null, channels: CampaignChannel[]): CampaignDraft | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as { sms?: unknown; email_subject?: unknown; email_body?: unknown };
    const draft: CampaignDraft = {};
    if (channels.includes("sms")) {
      if (typeof j.sms !== "string" || !j.sms.trim()) return null;
      draft.sms = j.sms.trim();
    }
    if (channels.includes("email")) {
      if (typeof j.email_subject !== "string" || typeof j.email_body !== "string" || !j.email_subject.trim() || !j.email_body.trim()) return null;
      draft.emailSubject = j.email_subject.trim();
      draft.emailBody = j.email_body.trim();
    }
    return draft;
  } catch {
    return null;
  }
}

/** Without an AI key: a plain draft built from the goal, labelled Sandbox in the app. */
export function sandboxCampaignDraft(req: Pick<CampaignDraftRequest, "goal" | "clinicName" | "channels">): CampaignDraft {
  const goal = req.goal.trim().replace(/\s+/g, " ").replace(/[.!]*$/, ".");
  const short = goal.length > 150 ? `${goal.slice(0, 147).replace(/\s+\S*$/, "")}…` : goal;
  return {
    ...(req.channels.includes("sms") ? { sms: `{{clinic_name}}: Hi {{client_first_name}}, ${short} Book for {{pet_names}}: {{booking_link}}` } : {}),
    ...(req.channels.includes("email")
      ? {
          emailSubject: `A note for {{pet_names}} from {{clinic_name}}`,
          emailBody: `Hi {{client_first_name}},\n\n${goal}\n\nYou can book a visit for {{pet_names}} here: {{booking_link}}\nOr call us at {{clinic_phone}}.\n\nThe team at {{clinic_name}}`,
        }
      : {}),
  };
}

// ---------- AI builds the whole campaign from one request ----------
//
// Staff type one request ("Bring back dogs not seen in a year, 10% off
// dental in February"). The request itself becomes the campaign's goal, word
// for word, so the copy check only accepts prices and dates staff wrote. The
// AI chooses the name, channels and audience rules; the rules go through
// validateAudience like rules made by hand. Staff review and approve.

export interface CampaignPlan {
  name: string;
  channels: CampaignChannel[];
  audience: Audience;
}

export interface CampaignPlanOptions {
  species: readonly string[];
  services: readonly { id: string; name: string }[];
}

export const CAMPAIGN_REQUEST_MIN = 10;
export const CAMPAIGN_REQUEST_MAX = 1000;

export function validateCampaignRequest(raw: unknown): string {
  const text = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (text.length < CAMPAIGN_REQUEST_MIN || text.length > CAMPAIGN_REQUEST_MAX) {
    throw new ValidationError("Describe the campaign in a sentence or two: who it is for and what you offer (10 to 1,000 characters).", { field: "request" });
  }
  return text;
}

const nullable = (type: "string" | "integer") => ({ type: [type, "null"] });

/** The model's answer: flat conditions (strict JSON schema), turned into AudienceCondition by parseCampaignPlan. */
export const CAMPAIGN_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "channels", "match", "conditions"],
  properties: {
    name: { type: "string" },
    channels: { type: "array", items: { type: "string", enum: ["sms", "email"] } },
    match: { type: "string", enum: ["all", "any"] },
    conditions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "species", "min_years", "max_years", "op", "months", "state", "days", "service"],
        properties: {
          type: { type: "string", enum: ["species", "pet_age", "last_visit", "vaccine", "service_gap"] },
          species: { type: "array", items: { type: "string" } },
          min_years: nullable("integer"),
          max_years: nullable("integer"),
          op: { type: ["string", "null"], enum: ["more_than", "within", null] },
          months: nullable("integer"),
          state: { type: ["string", "null"], enum: ["overdue", "due_within", null] },
          days: nullable("integer"),
          service: nullable("string"),
        },
      },
    },
  },
} as const;

export function buildCampaignPlanPrompt(request: string, options: CampaignPlanOptions): { system: string; user: string } {
  const system = [
    "You set up marketing campaigns for a veterinary clinic from a staff member's request.",
    "Return a short campaign name (under 60 characters), the channels (sms, email or both; both unless the request says otherwise), and audience rules.",
    "Audience rules describe the PETS a campaign is about; a client is included through any matching pet. Use as few rules as the request needs. Kinds of rule:",
    `- species: species is one of the list given (choose from: ${options.species.join(", ") || "dog, cat"}).`,
    "- pet_age: min_years and/or max_years (whole years).",
    "- last_visit: op more_than (not seen in N months, or never) or within (seen in the last N months), months 1 to 120.",
    "- vaccine: state overdue, or due_within with days 1 to 180.",
    `- service_gap: the pet has not had this service in N months (or ever). service must be one of these ids: ${options.services.map((s) => `${s.id} (${s.name})`).join(", ")}.`,
    'match is "all" when every rule must hold (usual), "any" when one is enough.',
    "Fill unused fields with null (species with []). Do not invent rules the request does not ask for.",
  ].join("\n");
  return { system, user: `Request: ${request}` };
}

type FlatCondition = {
  type?: unknown; species?: unknown; min_years?: unknown; max_years?: unknown; op?: unknown; months?: unknown; state?: unknown; days?: unknown; service?: unknown;
};

/** Reads the model's plan; null when it is not usable (the caller falls back). */
export function parseCampaignPlan(raw: unknown, options: CampaignPlanOptions): CampaignPlan | null {
  const j = (raw ?? {}) as { name?: unknown; channels?: unknown; match?: unknown; conditions?: unknown };
  const name = typeof j.name === "string" ? j.name.trim().slice(0, 120) : "";
  const channels = CAMPAIGN_CHANNELS.filter((c) => Array.isArray(j.channels) && j.channels.includes(c));
  if (!name || channels.length === 0 || !Array.isArray(j.conditions)) return null;
  const conditions = (j.conditions as FlatCondition[]).map((c) => {
    switch (c.type) {
      case "species":
        return { type: "species", values: Array.isArray(c.species) ? c.species : [] };
      case "pet_age":
        return { type: "pet_age", minYears: c.min_years ?? undefined, maxYears: c.max_years ?? undefined };
      case "last_visit":
        return { type: "last_visit", op: c.op, months: c.months };
      case "vaccine":
        return c.state === "overdue" ? { type: "vaccine", state: "overdue" } : { type: "vaccine", state: c.state, days: c.days };
      case "service_gap":
        return { type: "service_gap", service: c.service, months: c.months };
      default:
        return { type: c.type };
    }
  });
  try {
    const audience = validateAudience({ match: j.match, conditions }, { species: options.species, services: options.services.map((s) => s.id) });
    return { name, channels, audience };
  } catch {
    return null;
  }
}

/**
 * Without an AI key: a plan from keywords in the request (labelled Sandbox in
 * the app). Always returns at least one rule; staff adjust it on the page.
 */
export function sandboxCampaignPlan(request: string, options: CampaignPlanOptions): CampaignPlan {
  const t = request.toLowerCase();
  const conditions: AudienceCondition[] = [];
  const species = options.species.filter((s) => new RegExp(`\\b${s}s?\\b`).test(t));
  if (species.length) conditions.push({ type: "species", values: species });
  const months = /(\d{1,3})\s*months?/.exec(t)?.[1];
  const years = /(\d{1,2}|a|one)\s*years?/.exec(t)?.[1];
  const period = months ? Number(months) : years ? (/^\d+$/.test(years) ? Number(years) : 1) * 12 : 12;
  if (/\b(senior|older|elderly)\b/.test(t)) conditions.push({ type: "pet_age", minYears: 7 });
  if (/\bvaccin/.test(t) && /\boverdue\b/.test(t)) conditions.push({ type: "vaccine", state: "overdue" });
  else if (/\bvaccin/.test(t)) conditions.push({ type: "vaccine", state: "due_within", days: 30 });
  const service = options.services.find((s) => t.includes(s.id.split("_")[0]!) || t.includes(s.name.toLowerCase().split(" (")[0]!));
  if (service) conditions.push({ type: "service_gap", service: service.id, months: Math.min(period, 120) });
  else if (/\b(not seen|haven'?t seen|lapsed|bring back|win back|missed|overdue for a visit)\b/.test(t)) {
    conditions.push({ type: "last_visit", op: "more_than", months: Math.min(period, 120) });
  }
  if (conditions.length === 0) conditions.push({ type: "species", values: [...options.species] });
  const channels: CampaignChannel[] = /\b(text|sms)\b/.test(t) && !/\bemail\b/.test(t) ? ["sms"] : /\bemail\b/.test(t) && !/\b(text|sms)\b/.test(t) ? ["email"] : ["sms", "email"];
  const words = request.replace(/[^\p{L}\p{N}\s%-]/gu, " ").trim().split(/\s+/).slice(0, 6).join(" ");
  return { name: words.charAt(0).toUpperCase() + words.slice(1), channels, audience: { match: "all", conditions } };
}
