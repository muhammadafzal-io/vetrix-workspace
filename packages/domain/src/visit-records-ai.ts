// AI help with visit records (staff only, decided 27 Nov 2026). Two narrow
// jobs, both drafts that staff check and save themselves:
//   1. "Tidy" a rough note or recommendation into clear sentences.
//   2. Read a typed prescription line ("carprofen 75mg 1 tab bid x7d") into
//      the form's fields.
// The AI never suggests a diagnosis, a medicine or a dose. Every draft is
// checked against what staff typed: a number, unit or medicine-like word that
// was not in the original throws the draft away. Only the typed text is sent
// (with the species), never names or contact details. The front-desk AI
// still never reads visit records.
import { PRESCRIPTION_ROUTES, VISIT_RECORD_LIMITS, type PrescriptionRoute, type VisitEntryKind } from "./visit-records";

/** The most text staff can send for help at once. */
export const VISIT_AI_MAX_INPUT = 4000;

// ---------- Shared checks ----------

/** Numbers in a text, normalized ("7.50" and "7.5" match; "1,000" is 1000). */
export function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.replace(/(\d),(\d{3})/g, "$1$2").matchAll(/\d+(?:\.\d+)?/g)) out.add(String(Number(m[0])));
  return out;
}

// Number words the AI might write instead of digits ("twice" is fine: it
// restates "bid"). Written-out numbers above ten must come from the original.
const NUMBER_WORDS: Record<string, string> = {
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", fourteen: "14", fifteen: "15", twenty: "20", thirty: "30",
};

/**
 * Words that look like a medicine or a diagnosis (common drug and disease
 * endings). A draft may only use such a word if staff wrote it. This is a
 * safety net, not a dictionary: anything it misses is still checked by the
 * person saving the entry.
 */
const MEDICAL_TERM = /^(?=[a-z]{6,}$)[a-z]+(?:ine|ines|azole|cillin|mycin|cycline|profen|oxicam|olol|pril|sartan|sone|olone|statin|prazole|mab|dronate|floxacin|vir|itis|oma|osis|emia|algia|pathy|ectomy|otomy)$/;
/** Everyday words with those endings. */
const COMMON_WORDS = new Set([
  "routine", "medicine", "medicines", "examine", "examined", "feline", "canine", "equine", "bovine", "vaccine", "vaccines", "urine", "saline",
  "intestine", "intestines", "uterine", "machine", "combine", "determine", "imagine", "online", "decline", "outline", "baseline", "guideline",
  "guidelines", "genuine", "engine", "define", "divine", "marine", "famine", "cuisine", "doctrine", "trampoline", "airline", "headline", "deadline", "timeline", "pipeline", "sunshine", "quarantine", "discipline", "alkaline", "nicotine", "caffeine", "morning", "academia", "aroma",
]);
const isMedicalTerm = (w: string) => MEDICAL_TERM.test(w) && !COMMON_WORDS.has(w);
const DIAGNOSIS_WORDS = /\b(diagnos\w*|prognos\w*|suspect\w*|likely|probabl\w*|consistent with|rule out|differential\w*)\b/i;

const words = (text: string) => new Set(text.toLowerCase().match(/[a-z]+/g) ?? []);

export interface DraftCheck {
  ok: boolean;
  /** Why it was refused (logged; staff see a short message). */
  problems: string[];
}

/** Checks a tidied draft against the staff's original text. */
export function checkDraftAgainst(original: string, draft: string): DraftCheck {
  const problems: string[] = [];
  const allowedNumbers = numbersIn(original);
  for (const n of numbersIn(draft)) if (!allowedNumbers.has(n)) problems.push(`number ${n} is not in the original`);
  const originalWords = words(original);
  for (const w of words(draft)) {
    if (NUMBER_WORDS[w] && !allowedNumbers.has(NUMBER_WORDS[w]!) && !originalWords.has(w)) problems.push(`number word "${w}" is not in the original`);
    if (isMedicalTerm(w) && !originalWords.has(w)) problems.push(`"${w}" is not in the original`);
  }
  if (DIAGNOSIS_WORDS.test(draft) && !DIAGNOSIS_WORDS.test(original)) problems.push("adds a diagnosis or a guess");
  return { ok: problems.length === 0, problems };
}

// ---------- 1. Tidy a note or recommendation ----------

export const TIDY_NOTE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: { text: { type: "string" } },
} as const;

/** Shorthand the model may expand (it must not invent anything else). */
const ABBREVIATIONS = [
  "o / O = owner; hx = history; d = days; wk = weeks; w/ or w = with; w/o = without; btwn = between; approx = approximately",
  "LF / RF / LH / RH = left front / right front / left hind / right hind leg; L / R = left / right; bilat = both sides",
  "BAR = bright, alert and responsive; QAR = quiet, alert and responsive; WNL = within normal limits; NSF = no significant findings",
  "abd = abdomen; palp = palpation; V+ / D+ = vomiting / diarrhea; inapp = not eating; PU/PD = drinking and urinating more",
  "SC / SQ = injection under the skin; IM = injection into muscle; IV = into a vein; PO = by mouth; sid / bid / tid = once / twice / three times a day",
  "e-collar = protective cone collar; recheck = follow-up visit",
].join("\n");

export function buildTidyNotePrompt(input: { kind: VisitEntryKind; text: string; species: string }): { system: string; user: string } {
  const sections =
    input.kind === "note"
      ? "Use short labelled lines where they fit: 'Owner reports:', 'Findings:', 'Done:'. Leave out a label that has nothing under it."
      : "Write clear steps for the clinic team to give the owner: what to do at home, any medicine already named, and when to come back.";
  return {
    system: [
      `You tidy a veterinary clinic's ${input.kind === "note" ? "visit note" : "recommendation"} written in a hurry by clinic staff about a ${input.species}.`,
      "Rewrite it in clear, complete sentences in plain English, and spell out shorthand. Common clinic shorthand:",
      ABBREVIATIONS,
      "Example. Input: 'o says vomiting 2d, BAR, abd soft, no pain on palp. gave fluids SC'. Output: 'Owner reports: vomiting for 2 days.\\nFindings: bright, alert and responsive; abdomen soft, no pain when palpated.\\nDone: fluids given by injection under the skin.'",
      sections,
      "Never add anything that is not in the text: no findings, diagnoses, guesses, medicines, doses, numbers, dates or advice. Keep every number, unit and medicine name exactly.",
      "If something is unclear, keep the staff's own words for it. Do not use markdown, bullet symbols or emojis.",
    ].join("\n"),
    user: input.text,
  };
}

/** The draft to show staff, or null when it is empty, too long or fails the check. */
export function acceptTidiedNote(original: string, raw: unknown): { text: string; check: DraftCheck } | null {
  const text = typeof raw === "string" ? raw.replace(/\r\n/g, "\n").trim() : "";
  if (!text || text.length > VISIT_RECORD_LIMITS.entryChars || text.length > original.length * 3 + 300) return null;
  const check = checkDraftAgainst(original, text);
  return check.ok ? { text, check } : null;
}

// ---------- 2. Read a prescription line into fields ----------

export const PRESCRIPTION_PARSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["drug_name", "strength", "dose", "route", "frequency", "duration_days", "quantity", "refills"],
  properties: {
    drug_name: { type: "string" },
    strength: { type: "string" },
    dose: { type: "string" },
    route: { type: "string", enum: ["", ...PRESCRIPTION_ROUTES] },
    frequency: { type: "string" },
    duration_days: { type: "string" },
    quantity: { type: "string" },
    refills: { type: "string" },
  },
} as const;

export function buildPrescriptionParsePrompt(text: string): { system: string; user: string } {
  return {
    system: [
      "You copy a veterinary prescription line written by a doctor into form fields. You never choose a medicine or a dose.",
      "drug_name: the medicine name exactly as written. strength: e.g. '75 mg'. dose: how much each time, e.g. '1 tablet'.",
      `route: one of ${PRESCRIPTION_ROUTES.join(", ")}, only if the text says it (po = oral); else empty.`,
      "frequency: in plain English (sid = once a day, bid = twice a day, tid = three times a day, q8h = every 8 hours, eod = every other day).",
      "duration_days: whole number of days if stated (x7d = 7, 2 weeks = 14); quantity: e.g. '14 tablets'; refills: whole number if stated.",
      "Leave a field empty when the text does not say it. Never guess, never calculate a dose, never add a number that is not in the text (except days from weeks).",
    ].join("\n"),
    user: text,
  };
}

export interface ParsedPrescription {
  drugName: string;
  strength: string;
  dose: string;
  route: PrescriptionRoute | "";
  frequency: string;
  durationDays: string;
  quantity: string;
  refills: string;
}

const EMPTY_RX: ParsedPrescription = { drugName: "", strength: "", dose: "", route: "", frequency: "", durationDays: "", quantity: "", refills: "" };

/**
 * Keeps only fields that pass the check: the medicine name must be in the
 * text as written, and every number must come from the text (weeks may
 * become days). Returns null when nothing usable is left.
 */
export function acceptParsedPrescription(original: string, raw: Record<string, unknown> | null): ParsedPrescription | null {
  if (!raw) return null;
  const s = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string).trim().slice(0, 200) : "");
  const allowed = numbersIn(original);
  // "2 weeks" may become 14 days.
  for (const w of original.toLowerCase().matchAll(/(\d+)\s*(?:w|wk|wks|weeks?)\b/g)) allowed.add(String(Number(w[1]) * 7));
  const numbersOk = (v: string) => [...numbersIn(v)].every((n) => allowed.has(n));
  const lower = original.toLowerCase();

  const out: ParsedPrescription = { ...EMPTY_RX };
  const drug = s("drug_name");
  const asWord = new RegExp(`(^|[^a-z])${drug.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`);
  if (drug.length >= 3 && !/\d/.test(drug) && asWord.test(lower)) out.drugName = drug;
  for (const [key, field] of [["strength", "strength"], ["dose", "dose"], ["frequency", "frequency"], ["quantity", "quantity"]] as const) {
    const v = s(key);
    if (v && numbersOk(v) && ![...words(v)].some((w) => isMedicalTerm(w) && !lower.includes(w))) out[field] = v;
  }
  const route = s("route");
  if ((PRESCRIPTION_ROUTES as readonly string[]).includes(route)) out.route = route as PrescriptionRoute;
  for (const [key, field] of [["duration_days", "durationDays"], ["refills", "refills"]] as const) {
    const v = s(key);
    if (/^\d{1,4}$/.test(v) && allowed.has(String(Number(v)))) out[field] = String(Number(v));
  }
  return Object.values(out).some(Boolean) ? out : null;
}

// ---------- Sandbox (no OpenAI key): fixed rules ----------

const FREQUENCY: [RegExp, string][] = [
  [/\b(sid|q24h|once (a|per) day|daily)\b/i, "Once a day"],
  [/\b(bid|q12h|twice (a|per) day)\b/i, "Twice a day"],
  [/\b(tid|q8h)\b/i, "Three times a day"],
  [/\b(qid|q6h)\b/i, "Four times a day"],
  [/\b(eod|qod)\b/i, "Every other day"],
];
const ROUTE: [RegExp, PrescriptionRoute][] = [
  [/\b(po|oral(ly)?|by mouth)\b/i, "oral"],
  [/\b(topical(ly)?|on the skin)\b/i, "topical"],
  [/\b(sc|sq|subq|im|iv|inj(ection)?)\b/i, "injection"],
  [/\b(ophth\w*|eye drops?|ou|os|od)\b/i, "ophthalmic"],
  [/\b(otic|ear drops?|au)\b/i, "otic"],
];

/** A rule-based reading of common prescription shorthand, labelled "Sandbox". */
export function sandboxParsePrescription(text: string): ParsedPrescription | null {
  const t = text.trim().slice(0, VISIT_AI_MAX_INPUT);
  if (!t) return null;
  const out: ParsedPrescription = { ...EMPTY_RX };
  const strength = t.match(/(\d+(?:\.\d+)?)\s?(mg|mcg|µg|g|ml|mL|%|iu|IU)(?:\/(?:ml|mL|tab))?\b/);
  if (strength) out.strength = strength[0].replace(/(\d)(?=[a-zµ%])/i, "$1 ");
  const name = t.slice(0, strength?.index ?? t.length).match(/^\s*([A-Za-z][A-Za-z-]+(?:\s+[A-Za-z][A-Za-z-]+)?)/);
  if (name && !/^(give|take|apply)$/i.test(name[1]!)) out.drugName = name[1]!.trim();
  const dose = t.match(/\b(\d+(?:\.\d+)?|½|half)\s?(tabs?|tablets?|caps?|capsules?|ml|mL|drops?|pumps?)\b/i);
  if (dose && !/^#/.test(t.slice(Math.max(0, dose.index! - 1), dose.index!))) {
    const unit = dose[2]!.toLowerCase().replace(/^tabs?$/, "tablet").replace(/^caps?$/, "capsule");
    const n = dose[1]!;
    out.dose = `${n} ${unit}${n !== "1" && !unit.endsWith("s") && unit !== "ml" ? "s" : ""}`;
  }
  out.frequency = FREQUENCY.find(([re]) => re.test(t))?.[1] ?? "";
  out.route = ROUTE.find(([re]) => re.test(t))?.[1] ?? "";
  const days = t.match(/\bx\s?(\d{1,3})\s?(d|days?)\b|\bfor\s(\d{1,3})\s?days?\b/i);
  const weeks = t.match(/\bx?\s?(\d{1,2})\s?(w|wks?|weeks?)\b/i);
  if (days) out.durationDays = days[1] ?? days[3]!;
  else if (weeks) out.durationDays = String(Number(weeks[1]) * 7);
  const qty = t.match(/#\s?(\d{1,4})\b/) ?? t.match(/\b(\d{1,4})\s?(tabs?|tablets?|caps?|capsules?)\s+total\b/i);
  if (qty) out.quantity = `${qty[1]} ${/cap/i.test(t) && !/tab/i.test(t) ? "capsules" : "tablets"}`;
  const refills = t.match(/\b(\d{1,2})\s?(?:refills?|rf)\b|\brefills?:?\s?(\d{1,2})\b/i);
  if (refills) out.refills = refills[1] ?? refills[2]!;
  return Object.values(out).some(Boolean) ? out : null;
}
