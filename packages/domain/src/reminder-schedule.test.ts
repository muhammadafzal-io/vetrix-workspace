import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ValidationError } from "./errors";
import { dueReminders, type RetentionInput, type RetentionRule } from "./retention";
import {
  isRetryableSendFailure,
  MAX_OVERDUE_VACCINE_DAYS,
  nextSendAttempt,
  templateChoices,
  validateReminderSchedule,
  withClinicSchedule,
} from "./reminder-schedule";

const retention = JSON.parse(readFileSync(new URL("../../pack/veterinary/retention.json", import.meta.url), "utf8")) as {
  rules: RetentionRule[];
  templates: Record<string, string>;
};
const vaccineRule = retention.rules.find((r) => r.id === "vaccine_due")!;
const keys = Object.keys(retention.templates);
const allowed = new Set(templateChoices(vaccineRule, keys));

/** Muhammad's schedule: 30 and 7 days before, then 3 and 7 days overdue. */
const clinicSchedule = [
  { offset_days: 7, channels: ["sms", "email"], template: "vaccine_overdue_7" },
  { offset_days: -30, channels: ["email", "sms"], template: "vaccine_due_30" },
  { offset_days: 3, channels: ["sms"], template: "vaccine_overdue_3" },
  { offset_days: -7, channels: ["sms"], template: "vaccine_due_7" },
];

describe("clinic reminder schedules", () => {
  it("offers the vaccine messages, including the new overdue texts, and nothing from other rules", () => {
    expect(templateChoices(vaccineRule, keys)).toEqual(expect.arrayContaining(["vaccine_due_30", "vaccine_due_7", "vaccine_overdue_3", "vaccine_overdue_7", "vaccine_overdue_call"]));
    expect(templateChoices(vaccineRule, keys).some((k) => k.startsWith("wellness_"))).toBe(false);
  });

  it("accepts up to four touches and sorts them by day", () => {
    const valid = validateReminderSchedule(clinicSchedule, allowed);
    expect(valid.map((t) => t.offset_days)).toEqual([-30, -7, 3, 7]);
    expect(valid[0]!.channels).toEqual(["sms", "email"]); // fixed channel order
  });

  it.each([
    ["no touches", []],
    ["five touches", [...clinicSchedule, { offset_days: 14, channels: ["sms"], template: "vaccine_overdue_7" }]],
    ["two on the same day", [clinicSchedule[2], { ...clinicSchedule[2], channels: ["email"] }]],
    ["a day too far out", [{ offset_days: -91, channels: ["sms"], template: "vaccine_due_30" }]],
    ["half a day", [{ offset_days: 2.5, channels: ["sms"], template: "vaccine_overdue_3" }]],
    ["no channel", [{ offset_days: 3, channels: [], template: "vaccine_overdue_3" }]],
    ["an unknown channel", [{ offset_days: 3, channels: ["whatsapp"], template: "vaccine_overdue_3" }]],
    ["another rule's message", [{ offset_days: 3, channels: ["sms"], template: "wellness_due_30" }]],
  ])("refuses %s", (_, touches) => {
    expect(() => validateReminderSchedule(touches, allowed)).toThrow(ValidationError);
  });

  it("runs the clinic's schedule, and falls back to the pack when the stored one is no longer valid", () => {
    expect(withClinicSchedule(vaccineRule, { touches: clinicSchedule }, keys).touches.map((t) => t.offset_days)).toEqual([-30, -7, 3, 7]);
    expect(withClinicSchedule(vaccineRule, {}, keys)).toBe(vaccineRule);
    expect(withClinicSchedule(vaccineRule, { touches: [{ offset_days: 3, channels: ["sms"], template: "gone" }] }, keys)).toBe(vaccineRule);
  });
});

describe("overdue vaccine reminders with the clinic schedule", () => {
  const rule = withClinicSchedule(vaccineRule, { touches: clinicSchedule }, keys);
  const at = (asOf: string, dueAt: string): RetentionInput => ({
    asOf,
    rules: [rule],
    patients: [{ id: "p1", clientId: "c1", name: "Bella", species: "dog", dateOfBirth: "2020-01-01", approxAgeMonths: null, status: "active", lastWellnessAt: null, lastSurgeryAt: null }],
    clients: [{ id: "c1", firstName: "Sam", householdId: null, flags: [], smsConsent: true, email: "sam@example.com" }],
    vaccines: [{ patientId: "p1", vaccineName: "Rabies", dueAt }],
    prevention: [],
    noShows: [],
    booked: [],
  });
  const activeOffsets = (asOf: string) => dueReminders(at(asOf, "2026-11-01")).flatMap((r) => r.active.map((t) => t.offsetDays));

  it("sends nothing overdue before day 3, the +3 text from day 3, and adds the +7 touch from day 7", () => {
    expect(activeOffsets("2026-11-03")).toEqual([]);
    expect(activeOffsets("2026-11-04")).toEqual([3]);
    expect(activeOffsets("2026-11-08")).toEqual([3, 7]);
  });

  it(`stops after ${MAX_OVERDUE_VACCINE_DAYS} days overdue`, () => {
    expect(dueReminders(at("2026-12-31", "2026-11-01"))).toHaveLength(1); // 60 days
    expect(dueReminders(at("2027-01-01", "2026-11-01"))).toHaveLength(0); // 61 days
  });
});

describe("retrying failed sends", () => {
  const now = Date.parse("2026-11-24T10:00:00Z");

  it("retries network errors, 429 and 5xx, but not a refused number", () => {
    expect([null, 0, 429, 500, 503].map(isRetryableSendFailure)).toEqual([true, true, true, true, true]);
    expect([400, 401, 404].map(isRetryableSendFailure)).toEqual([false, false, false]);
  });

  it("waits 5 minutes, 30 minutes, then 2 hours, and gives up after the fourth try", () => {
    expect(nextSendAttempt(1, true, now)?.toISOString()).toBe("2026-11-24T10:05:00.000Z");
    expect(nextSendAttempt(2, true, now)?.toISOString()).toBe("2026-11-24T10:30:00.000Z");
    expect(nextSendAttempt(3, true, now)?.toISOString()).toBe("2026-11-24T12:00:00.000Z");
    expect(nextSendAttempt(4, true, now)).toBeNull();
    expect(nextSendAttempt(1, false, now)).toBeNull();
  });
});
