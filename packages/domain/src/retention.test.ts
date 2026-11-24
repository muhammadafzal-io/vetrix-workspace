// The reminder engine against the pack's test data on its reference date
// (docs/test-data/expected-reminders.md).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv";
import { dueReminders, planSends, reminderCounts, touchIsActive, type RetentionInput } from "./retention";

const file = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const retention = JSON.parse(file("../../pack/veterinary/retention.json"));
const csv = (name: string) => parseCsv(file(`../../../docs/test-data/${name}`));
const vaccineName = new Map<string, string>((retention.vaccines as { id: string; name: string }[]).map((v) => [v.id, v.name.split(" (")[0]!]));

function input(asOf: string): RetentionInput {
  return {
    asOf,
    rules: retention.rules,
    patients: csv("patients.csv").map((p) => ({
      id: p.id!, clientId: p.client_id!, name: p.name!, species: p.species!, dateOfBirth: p.date_of_birth || null, approxAgeMonths: null,
      status: p.status!, lastWellnessAt: p.last_wellness_exam_at || null, lastSurgeryAt: p.last_surgery_at || null,
    })),
    clients: csv("clients.csv").map((c) => ({
      id: c.id!, firstName: c.first_name!, householdId: c.household_id || null, flags: (c.flags ?? "").split(/[;|,]/).filter(Boolean),
      smsConsent: c.sms_consent === "true", email: c.email || null,
    })),
    vaccines: csv("vaccine_records.csv").map((v) => ({ patientId: v.patient_id!, vaccineName: vaccineName.get(v.vaccine_id!) ?? v.vaccine_id!, dueAt: v.due_at! })),
    prevention: csv("prevention_products.csv").map((p) => ({ patientId: p.patient_id!, productName: p.product_name!, supplyEndAt: p.supply_end_at! })),
    noShows: csv("visits.csv").filter((v) => v.status === "no_show").map((v) => ({ patientId: v.patient_id!, date: v.date! })),
    booked: [],
  };
}

describe("reminder engine on the test data (reference date 2026-11-03)", () => {
  const data = input("2026-11-03");
  const items = dueReminders(data);
  const counts = reminderCounts(items);

  it.each([
    ["annual_wellness:-30", 11],
    ["annual_wellness:-7", 3],
    ["annual_wellness:14", 23],
    ["senior_recheck:-21", 1],
    ["senior_recheck:14", 15],
    ["vaccine_due:-30", 25],
    ["vaccine_due:7", 25],
    ["parasite_prevention_refill:0", 13],
    ["no_show_recovery:all", 2],
    ["post_surgery_recheck:all", 2],
  ])("%s → %i", (key, expected) => {
    expect(counts.get(key) ?? 0).toBe(expected);
  });

  it("sends nothing for deceased, transferred or do-not-contact pets", () => {
    for (const id of ["pat_009", "pat_031", "pat_040"]) expect(items.filter((i) => i.patientId === id)).toHaveLength(0);
    for (const id of ["pat_037", "pat_038"]) expect(items.filter((i) => i.patientId === id).every((i) => i.suppressed)).toBe(true);
  });

  it("plans texts only with consent, merges a household and never mentions a deceased pet", () => {
    const plan = planSends({
      items,
      patients: data.patients,
      clients: data.clients,
      sent: new Set(),
      templates: retention.templates,
      merge: { ...retention.household_merge, windowDays: retention.engine.household_merge_window_days },
      values: { clinicName: "Main Veterinary Clinic", aiName: "Riley", clinicPhone: "(555) 010-1000", bookingLink: "reply to this text" },
    });
    const noConsent = new Set(data.clients.filter((c) => !c.smsConsent).map((c) => c.id));
    expect(plan.plans.filter((p) => p.channel === "sms" && noConsent.has(p.clientId))).toHaveLength(0);
    expect(plan.plans.some((p) => p.templateKey === "household_reminder" && p.petNames.length >= 2)).toBe(true);
    const pumpkin = data.patients.find((p) => p.id === "pat_009")!.name;
    const hh006 = data.clients.filter((c) => c.householdId === "hh_006").map((c) => c.id);
    expect(plan.plans.filter((p) => hh006.includes(p.clientId)).every((p) => !p.body.includes(pumpkin))).toBe(true);
    expect(plan.plans.every((p) => !p.body.includes("{{"))).toBe(true);
  });

  it("does not send a touch twice, and an overtaken touch is not sent late", () => {
    const base = { patients: data.patients, clients: data.clients, templates: retention.templates, merge: { ...retention.household_merge, windowDays: 14 }, values: { clinicName: "C", aiName: "Riley", clinicPhone: "1", bookingLink: "reply" } };
    const first = planSends({ items, sent: new Set(), ...base });
    const sent = new Set(first.plans.flatMap((p) => p.touches.map((t) => `${t.ruleId}|${t.patientId}|${t.dueAt}|${t.touchIndex}`)));
    for (const s of first.superseded) sent.add(`${s.ruleId}|${s.patientId}|${s.dueAt}|${s.touchIndex}`);
    expect(planSends({ items, sent, ...base }).plans).toHaveLength(0);
  });
});

describe("touch windows", () => {
  it("before the due date counts down to it; after, from the offset on", () => {
    expect([touchIsActive(-30, 30), touchIsActive(-30, 31), touchIsActive(-30, -1)]).toEqual([true, false, false]);
    expect([touchIsActive(14, -14), touchIsActive(14, -13), touchIsActive(0, 0)]).toEqual([true, false, true]);
  });
});

describe("email when a text can't go", () => {
  const rule = { id: "vaccine_due", name: "Vaccine due", species: ["dog"], touches: [{ offset_days: -7, channels: ["sms" as const], template: "t" }] };
  const base = (client: { smsConsent: boolean; email: string | null }) => {
    const input = {
      asOf: "2026-11-24",
      rules: [rule],
      patients: [{ id: "p", clientId: "c", name: "Simba", species: "dog", dateOfBirth: null, approxAgeMonths: null, status: "active", lastWellnessAt: null, lastSurgeryAt: null }],
      clients: [{ id: "c", firstName: "Sam", householdId: null, flags: [], ...client }],
      vaccines: [{ patientId: "p", vaccineName: "DAPP", dueAt: "2026-11-28" }],
      prevention: [],
      noShows: [],
      booked: [],
    };
    return planSends({
      items: dueReminders(input),
      patients: input.patients,
      clients: input.clients,
      sent: new Set(),
      templates: { t: "{{clinic_name}}: {{pet_name}} is due. Book: {{booking_link}} Reply STOP to opt out." },
      merge: { applies_to_rules: [], template_multi: "", windowDays: 14 },
      values: { clinicName: "Main Veterinary Clinic", aiName: "Riley", clinicPhone: "1", bookingLink: "https://book" },
    });
  };

  it("sends a text-only step by email to a client who can't be texted, without the STOP line", () => {
    const r = base({ smsConsent: false, email: "sam@example.com" });
    expect(r.plans.map((p) => p.channel)).toEqual(["email"]);
    expect(r.plans[0]!.body).toBe("Main Veterinary Clinic: Simba is due. Book: https://book");
    expect(r.skipped).toEqual([]);
  });

  it("texts (only) a client who can be texted, and skips one with neither", () => {
    expect(base({ smsConsent: true, email: "sam@example.com" }).plans.map((p) => p.channel)).toEqual(["sms"]);
    const none = base({ smsConsent: false, email: null });
    expect(none.plans).toEqual([]);
    expect(none.skipped).toHaveLength(1);
  });
});
