// Public booking widget: the "Book a visit" button a clinic puts on its own
// website. Visitors prove their mobile number with a texted code, then book a
// routine visit, chat with the AI front desk, or call.
import { ValidationError } from "./errors";
import { validateClient, validatePatient, type Species, type ValidClient, type ValidPatient } from "./clients";

export const WIDGET = {
  codeLength: 6,
  /** A texted code works this long. */
  codeMinutes: 10,
  /** Wrong tries before a code stops working. */
  maxAttempts: 5,
  /** Wait before "Send a new code". */
  resendSeconds: 30,
  /** Codes texted to one number per hour. */
  sendsPerHour: 3,
  /** How long a verified visitor stays signed in to the widget. */
  sessionMinutes: 30,
  /** Allowed websites per clinic. */
  maxOrigins: 5,
} as const;

/**
 * Pack services a client may book online by default. Sick visits are left out
 * on purpose: they go through the AI front desk so triage always runs.
 */
export const ONLINE_DEFAULT_SERVICES = new Set([
  "wellness_exam_new",
  "wellness_exam",
  "senior_wellness",
  "puppy_kitten_visit",
  "recheck_exam",
  "vaccine_booster_tech",
  "nail_trim",
  "microchip",
  "heartworm_test",
  "weight_check",
  "health_certificate",
]);

/** Never bookable online, whatever the setting says (staff judgement, deposits, or pack rules). */
const NEVER_ONLINE_CATEGORIES = new Set(["surgery"]);
const NEVER_ONLINE_SERVICES = new Set(["euthanasia", "sick_visit", "sedated_procedure", "drop_off_visit", "rx_refill_request"]);

export function canBookOnline(service: { packServiceId: string; category: string }): boolean {
  return !NEVER_ONLINE_CATEGORIES.has(service.category) && !NEVER_ONLINE_SERVICES.has(service.packServiceId);
}

export function isWidgetCode(code: string): boolean {
  return new RegExp(`^\\d{${WIDGET.codeLength}}$`).test(code);
}

export function codeText(clinicName: string, code: string): string {
  return `${clinicName} code: ${code}. It expires in ${WIDGET.codeMinutes} minutes. If you didn't ask for it, ignore this text.`;
}

// ---------- Allowed websites ----------

/**
 * Turns what staff type ("happypaws.com, https://www.happypaws.com/book") into
 * origins for the frame rule ("https://happypaws.com"). Only https, except
 * localhost for testing.
 */
export function parseWidgetOrigins(text: string): string[] {
  const parts = text
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out = new Set<string>();
  for (const raw of parts) {
    const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
    let url: URL;
    try {
      url = new URL(withScheme);
    } catch {
      throw new ValidationError(`"${raw}" is not a website address.`, { field: "origins" });
    }
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
      throw new ValidationError(`Use an https:// address for ${url.hostname}.`, { field: "origins" });
    }
    if (!local && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(url.hostname)) {
      throw new ValidationError(`"${raw}" is not a website address.`, { field: "origins" });
    }
    out.add(url.origin.toLowerCase());
  }
  if (out.size > WIDGET.maxOrigins) throw new ValidationError(`Add up to ${WIDGET.maxOrigins} websites.`, { field: "origins" });
  return [...out];
}

// ---------- New clients ----------

export const AGE_BANDS = {
  under_6m: { label: "Under 6 months", months: 3 },
  "6m_2y": { label: "6 months to 2 years", months: 12 },
  "2y_7y": { label: "2 to 7 years", months: 48 },
  "7y_plus": { label: "7 years or older", months: 96 },
  not_sure: { label: "Not sure", months: null },
} as const;
export type AgeBand = keyof typeof AGE_BANDS;

export interface NewClientForm {
  firstName: string;
  lastName: string;
  email?: string | null;
  smsConsent: boolean;
  petName: string;
  species: Species;
  ageBand: AgeBand;
  sex: "male" | "female" | null;
}

/** A new client and their first pet from the widget form. The mobile is the verified one. */
export function validateNewClient(form: NewClientForm, mobile: string, today: string): { client: ValidClient; patient: ValidPatient } {
  if (!(form.ageBand in AGE_BANDS)) throw new ValidationError("Choose an age.", { field: "ageBand" });
  if (form.sex !== null && form.sex !== "male" && form.sex !== "female") throw new ValidationError("Choose boy or girl.", { field: "sex" });
  const client = validateClient({
    firstName: form.firstName,
    lastName: form.lastName,
    mobile,
    email: form.email ?? null,
    preferredChannel: form.smsConsent ? "sms" : form.email?.trim() ? "email" : "call",
    smsConsent: form.smsConsent === true,
  });
  const patient = validatePatient(
    { name: form.petName, species: form.species, sex: form.sex, approxAgeMonths: AGE_BANDS[form.ageBand].months },
    today,
  );
  return { client, patient };
}
