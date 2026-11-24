// A clinic's own reminder schedule (stored in reminder_rules.overrides) and
// the retry rules for messages that failed to send.
//
// The pack sets the default schedule for every rule. A clinic may replace a
// rule's touches (when, which channels, which message) within these limits;
// the engine in retention.ts then runs the clinic's schedule unchanged.
import { ValidationError } from "./errors";
import type { RetentionRule, RetentionTouch } from "./retention";

export const REMINDER_SCHEDULE_LIMITS = {
  /** Pack v0.2 allows 3 per rule; a clinic's own schedule may have 4 (approved 24 Nov 2026). */
  maxTouches: 4,
  /** Earliest touch: 90 days before the due date. */
  minOffsetDays: -90,
  /** Latest touch: 60 days after the due date. */
  maxOffsetDays: 60,
} as const;

/** Overdue vaccine reminders stop after this many days: by then it is a win-back, not a reminder. */
export const MAX_OVERDUE_VACCINE_DAYS = 60;

export const REMINDER_CHANNELS = ["sms", "email", "ai_call"] as const;
export type ReminderChannel = (typeof REMINDER_CHANNELS)[number];

export interface ScheduleTouch {
  offset_days: number;
  channels: ReminderChannel[];
  template: string;
}

export interface ReminderRuleOverrides {
  touches?: ScheduleTouch[];
}

/**
 * Message templates a rule may use: the ones its pack touches use, plus any
 * template named after the rule's subject ("vaccine_…" for vaccine_due).
 */
export function templateChoices(rule: Pick<RetentionRule, "id" | "touches">, templateKeys: Iterable<string>): string[] {
  const prefix = `${rule.id.split("_")[0]}_`;
  const own = new Set(rule.touches.map((t) => t.template));
  return [...templateKeys].filter((k) => own.has(k) || k.startsWith(prefix)).sort();
}

/**
 * Checks a schedule a clinic wants for one rule and returns it sorted by day.
 * Throws a ValidationError a person can act on.
 */
export function validateReminderSchedule(raw: unknown, allowedTemplates: ReadonlySet<string>): ScheduleTouch[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ValidationError("Add at least one reminder.", { field: "touches" });
  const { maxTouches, minOffsetDays, maxOffsetDays } = REMINDER_SCHEDULE_LIMITS;
  if (raw.length > maxTouches) throw new ValidationError(`A reminder can go out at most ${maxTouches} times.`, { field: "touches" });
  const out = raw.map((t: unknown, i): ScheduleTouch => {
    const row = (t ?? {}) as Record<string, unknown>;
    const offset = typeof row.offset_days === "string" ? Number(row.offset_days) : row.offset_days;
    if (typeof offset !== "number" || !Number.isInteger(offset) || offset < minOffsetDays || offset > maxOffsetDays) {
      throw new ValidationError(`Choose a day between ${-minOffsetDays} days before and ${maxOffsetDays} days after the due date.`, { field: `touches.${i}.offset_days` });
    }
    const channels = [...new Set(Array.isArray(row.channels) ? row.channels : [])];
    if (channels.length === 0 || !channels.every((c): c is ReminderChannel => (REMINDER_CHANNELS as readonly unknown[]).includes(c))) {
      throw new ValidationError("Choose how each reminder goes out: text, email or AI call.", { field: `touches.${i}.channels` });
    }
    if (typeof row.template !== "string" || !allowedTemplates.has(row.template)) {
      throw new ValidationError("Choose a message for each reminder.", { field: `touches.${i}.template` });
    }
    return { offset_days: offset, channels: REMINDER_CHANNELS.filter((c) => channels.includes(c)), template: row.template };
  });
  out.sort((a, b) => a.offset_days - b.offset_days);
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.offset_days === out[i - 1]!.offset_days) throw new ValidationError("Two reminders are set for the same day. Choose different days.", { field: "touches" });
  }
  return out;
}

/**
 * The rule as this clinic runs it: the pack rule with the clinic's touches,
 * when it has a valid schedule of its own. A stored schedule that is no
 * longer valid (e.g. a template removed from the pack) falls back to the pack.
 */
export function withClinicSchedule(rule: RetentionRule, overrides: unknown, templateKeys: Iterable<string>): RetentionRule {
  const touches = (overrides as ReminderRuleOverrides | null)?.touches;
  if (!touches) return rule;
  try {
    const valid = validateReminderSchedule(touches, new Set(templateChoices(rule, templateKeys)));
    return { ...rule, touches: valid.map((t): RetentionTouch => ({ offset_days: t.offset_days, channels: t.channels, template: t.template })) };
  } catch {
    return rule;
  }
}

// ---------- Retrying failed sends ----------

/** Waits before each retry: 5 minutes, 30 minutes, 2 hours. Four tries in all. */
export const SEND_RETRY_DELAYS_MIN = [5, 30, 120] as const;

/**
 * Whether a provider's answer is worth trying again: no answer at all (network
 * error, timeout), too many requests, or a server error. A refused number or
 * a bad request will fail the same way again.
 */
export function isRetryableSendFailure(httpStatus: number | null): boolean {
  return httpStatus === null || httpStatus === 0 || httpStatus === 429 || httpStatus >= 500;
}

/**
 * When to try a failed send again, or null to give up. `attempts` counts the
 * tries so far, including the one that just failed.
 */
export function nextSendAttempt(attempts: number, retryable: boolean, now: number): Date | null {
  if (!retryable || attempts < 1 || attempts > SEND_RETRY_DELAYS_MIN.length) return null;
  return new Date(now + SEND_RETRY_DELAYS_MIN[attempts - 1]! * 60_000);
}
