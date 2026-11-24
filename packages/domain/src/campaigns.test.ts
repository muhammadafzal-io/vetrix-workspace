import { describe, expect, it } from "vitest";
import {
  campaignEligibility,
  canChangeCampaign,
  checkCampaignCopy,
  fillCampaignMessage,
  joinPetNames,
  parseCampaignDraft,
  parseCampaignPlan,
  sandboxCampaignDraft,
  sandboxCampaignPlan,
  selectAudience,
  validateAudience,
  validateCampaignRequest,
  type AudiencePet,
  type CampaignClient,
} from "./campaigns";
import { ValidationError } from "./errors";

const allowed = { species: ["dog", "cat"], services: ["dental_cleaning", "wellness_exam"] };
const today = "2026-11-24";

const pet = (over: Partial<AudiencePet>): AudiencePet => ({
  id: "p", clientId: "c", name: "Bella", species: "dog", ageYears: 5, lastVisitAt: "2026-06-01", nextVaccineDueAt: null, lastServiceAt: {}, ...over,
});

describe("audience rules", () => {
  it("accepts one level of rules and refuses an empty or unknown rule", () => {
    expect(validateAudience({ match: "all", conditions: [{ type: "species", values: ["dog"] }, { type: "last_visit", op: "more_than", months: "12" }] }, allowed)).toEqual({
      match: "all",
      conditions: [{ type: "species", values: ["dog"] }, { type: "last_visit", op: "more_than", months: 12 }],
    });
    expect(() => validateAudience({ match: "all", conditions: [] }, allowed)).toThrow(ValidationError);
    expect(() => validateAudience({ match: "all", conditions: [{ type: "species", values: ["horse"] }] }, allowed)).toThrow(ValidationError);
    expect(() => validateAudience({ match: "all", conditions: [{ type: "service_gap", service: "botox", months: 6 }] }, allowed)).toThrow(ValidationError);
    expect(() => validateAudience({ match: "all", conditions: [{ type: "pet_age", minYears: 9, maxYears: 3 }] }, allowed)).toThrow(ValidationError);
    expect(() => validateAudience({ match: "both", conditions: [{ type: "vaccine", state: "overdue" }] }, allowed)).toThrow(ValidationError);
  });

  it("matches ALL and ANY, and groups pets under their client", () => {
    const pets = [
      pet({ id: "1", clientId: "a", name: "Old dog", lastVisitAt: "2025-01-10" }),
      pet({ id: "2", clientId: "a", name: "Never seen", lastVisitAt: null }),
      pet({ id: "3", clientId: "b", name: "Recent cat", species: "cat", lastVisitAt: "2026-10-01" }),
      pet({ id: "4", clientId: "c", name: "Old cat", species: "cat", lastVisitAt: "2024-01-01" }),
    ];
    const lapsedDogs = selectAudience({ match: "all", conditions: [{ type: "species", values: ["dog"] }, { type: "last_visit", op: "more_than", months: 12 }] }, pets, today);
    expect([...lapsedDogs.keys()]).toEqual(["a"]);
    expect(lapsedDogs.get("a")!.map((p) => p.name)).toEqual(["Old dog", "Never seen"]);
    const dogsOrLapsed = selectAudience({ match: "any", conditions: [{ type: "species", values: ["dog"] }, { type: "last_visit", op: "more_than", months: 12 }] }, pets, today);
    expect([...dogsOrLapsed.keys()].sort()).toEqual(["a", "c"]);
  });

  it("checks age, vaccines and time since a service", () => {
    const p = pet({ ageYears: 8.5, nextVaccineDueAt: "2026-12-10", lastServiceAt: { dental_cleaning: "2025-03-01" } });
    const one = (c: Parameters<typeof validateAudience>[0]) => selectAudience(validateAudience(c, allowed), [p], today).size;
    expect(one({ match: "all", conditions: [{ type: "pet_age", minYears: 7 }] })).toBe(1);
    expect(one({ match: "all", conditions: [{ type: "pet_age", maxYears: 7 }] })).toBe(0);
    expect(one({ match: "all", conditions: [{ type: "pet_age", minYears: 8, maxYears: 8 }] })).toBe(1); // 8.5 is "8 years old"
    expect(one({ match: "all", conditions: [{ type: "vaccine", state: "due_within", days: 30 }] })).toBe(1);
    expect(one({ match: "all", conditions: [{ type: "vaccine", state: "overdue" }] })).toBe(0);
    expect(one({ match: "all", conditions: [{ type: "service_gap", service: "dental_cleaning", months: 12 }] })).toBe(1);
    expect(one({ match: "all", conditions: [{ type: "service_gap", service: "dental_cleaning", months: 24 }] })).toBe(0);
    expect(one({ match: "all", conditions: [{ type: "service_gap", service: "wellness_exam", months: 1 }] })).toBe(1); // never had it
  });
});

describe("who may receive a campaign", () => {
  const now = Date.parse("2026-11-24T12:00:00Z");
  const client = (over: Partial<CampaignClient>): CampaignClient => ({
    id: "c", firstName: "Sam", marketingConsent: true, smsConsent: true, email: "sam@example.com", flags: [], lastCampaignAt: null, ...over,
  });

  it("needs marketing consent, text consent for texts, an email for emails, and respects do not contact", () => {
    expect(campaignEligibility(client({}), "sms", now)).toBeNull();
    expect(campaignEligibility(client({ marketingConsent: false }), "email", now)).toBe("no_marketing_consent");
    expect(campaignEligibility(client({ smsConsent: false }), "sms", now)).toBe("no_sms_consent");
    expect(campaignEligibility(client({ smsConsent: false }), "email", now)).toBeNull();
    expect(campaignEligibility(client({ email: null }), "email", now)).toBe("no_email");
    expect(campaignEligibility(client({ flags: ["do_not_contact"] }), "email", now)).toBe("do_not_contact");
  });

  it("sends at most one campaign message per 7 days", () => {
    expect(campaignEligibility(client({ lastCampaignAt: new Date(now - 6 * 86_400_000) }), "sms", now)).toBe("contacted_recently");
    expect(campaignEligibility(client({ lastCampaignAt: new Date(now - 7 * 86_400_000) }), "sms", now)).toBeNull();
  });
});

describe("campaign status", () => {
  it("moves forward and can go back to draft until it is sending", () => {
    expect(canChangeCampaign("draft", "approved")).toBe(true);
    expect(canChangeCampaign("approved", "draft")).toBe(true);
    expect(canChangeCampaign("draft", "scheduled")).toBe(false); // must be approved first
    expect(canChangeCampaign("sending", "draft")).toBe(false);
    expect(canChangeCampaign("sent", "cancelled")).toBe(false);
  });
});

describe("campaign copy check", () => {
  const facts = "Goal: February is dental month, 10% off dental cleaning, book by Feb 28. Clinic: Main Veterinary Clinic, (555) 010-1000.";

  it("accepts facts that come from the goal or the clinic, and placeholders", () => {
    expect(checkCampaignCopy({ channel: "sms", body: "{{clinic_name}}: 10% off dental cleaning for {{pet_names}} until Feb 28. Book: {{booking_link}} or call (555) 010-1000." }, facts)).toEqual([]);
  });

  it("refuses invented prices, discounts, dates and links, unknown placeholders and promises", () => {
    const issues = checkCampaignCopy(
      { channel: "email", subject: "Save 20%!", body: "Only $49 until March 15 at www.example.com, {{coupon}}. Guaranteed healthy teeth!" },
      facts,
    );
    expect(issues.map((i) => i.kind).sort()).toEqual(["claim", "fact", "fact", "fact", "fact", "placeholder"]);
  });

  it("needs a subject for email, a short text and no forbidden terms", () => {
    expect(checkCampaignCopy({ channel: "email", subject: "", body: "Hi" }, facts).map((i) => i.kind)).toEqual(["empty"]);
    expect(checkCampaignCopy({ channel: "sms", body: "x".repeat(400) }, facts).map((i) => i.kind)).toEqual(["length"]);
    expect(checkCampaignCopy({ channel: "sms", body: "Visit our med spa" }, facts, ["med spa"]).map((i) => i.kind)).toEqual(["term"]);
  });
});

describe("filling a campaign message", () => {
  const values = { client_first_name: "Sam", pet_names: joinPetNames(["Bella", "Max"]), clinic_name: "Main Veterinary Clinic", clinic_phone: "(555) 010-1000", booking_link: "https://app/w/main" };

  it("fills placeholders per client and adds the STOP line to texts only", () => {
    expect(fillCampaignMessage("{{clinic_name}}: Hi {{client_first_name}}, {{pet_names}} are due. {{booking_link}}", "sms", values)).toBe(
      "Main Veterinary Clinic: Hi Sam, Bella and Max are due. https://app/w/main Reply STOP to opt out.",
    );
    expect(fillCampaignMessage("Hi {{client_first_name}}", "email", values)).toBe("Hi Sam");
    expect(joinPetNames(["A", "B", "C"])).toBe("A, B and C");
    expect(joinPetNames([])).toBe("your pet");
  });
});

describe("AI drafts", () => {
  it("reads the model's answer, requiring what each channel needs", () => {
    expect(parseCampaignDraft('{"sms":"Hi","email_subject":"","email_body":""}', ["sms"])).toEqual({ sms: "Hi" });
    expect(parseCampaignDraft('{"sms":"Hi","email_subject":"","email_body":""}', ["sms", "email"])).toBeNull();
    expect(parseCampaignDraft("not json", ["sms"])).toBeNull();
  });

  it("writes a sandbox draft that passes the copy check", () => {
    const goal = "February is dental month: 10% off dental cleaning.";
    const d = sandboxCampaignDraft({ goal, clinicName: "Main Veterinary Clinic", channels: ["sms", "email"] });
    expect(checkCampaignCopy({ channel: "sms", body: d.sms! }, goal)).toEqual([]);
    expect(checkCampaignCopy({ channel: "email", subject: d.emailSubject, body: d.emailBody! }, goal)).toEqual([]);
  });
});

describe("AI builds a campaign from one request", () => {
  const options = { species: ["cat", "dog"], services: [{ id: "dental_cleaning", name: "Dental cleaning (COHAT)" }, { id: "wellness_exam", name: "Wellness exam" }] };
  const flat = (over: Record<string, unknown>) => ({ type: "species", species: [], min_years: null, max_years: null, op: null, months: null, state: null, days: null, service: null, ...over });

  it("checks the request length", () => {
    expect(validateCampaignRequest("  Dental month   for dogs, 10% off  ")).toBe("Dental month for dogs, 10% off");
    expect(() => validateCampaignRequest("hi")).toThrow(ValidationError);
  });

  it("turns the model's flat rules into checked audience rules", () => {
    const plan = parseCampaignPlan(
      { name: "Dental month", channels: ["sms", "email"], match: "all", conditions: [flat({ species: ["dog", "cat"] }), flat({ type: "service_gap", service: "dental_cleaning", months: 12 })] },
      options,
    );
    expect(plan).toEqual({
      name: "Dental month",
      channels: ["sms", "email"],
      audience: { match: "all", conditions: [{ type: "species", values: ["dog", "cat"] }, { type: "service_gap", service: "dental_cleaning", months: 12 }] },
    });
  });

  it("refuses a plan with an unknown service, species or no rules", () => {
    expect(parseCampaignPlan({ name: "X", channels: ["sms"], match: "all", conditions: [flat({ type: "service_gap", service: "botox", months: 6 })] }, options)).toBeNull();
    expect(parseCampaignPlan({ name: "X", channels: ["sms"], match: "all", conditions: [flat({ species: ["horse"] })] }, options)).toBeNull();
    expect(parseCampaignPlan({ name: "X", channels: ["sms"], match: "all", conditions: [] }, options)).toBeNull();
    expect(parseCampaignPlan({ name: "X", channels: [], match: "all", conditions: [flat({ species: ["dog"] })] }, options)).toBeNull();
  });

  it("builds a sandbox plan from keywords, always with at least one rule", () => {
    expect(sandboxCampaignPlan("Bring back dogs and cats who haven't had a dental cleaning in a year. Text only.", options)).toEqual({
      name: "Bring back dogs and cats who",
      channels: ["sms"],
      audience: { match: "all", conditions: [{ type: "species", values: ["cat", "dog"] }, { type: "service_gap", service: "dental_cleaning", months: 12 }] },
    });
    expect(sandboxCampaignPlan("Senior pets with vaccines overdue", options).audience.conditions).toEqual([{ type: "pet_age", minYears: 7 }, { type: "vaccine", state: "overdue" }]);
    expect(sandboxCampaignPlan("Win back clients not seen in 18 months", options).audience.conditions).toEqual([{ type: "last_visit", op: "more_than", months: 18 }]);
    expect(sandboxCampaignPlan("Happy holidays from the team", options).audience.conditions).toEqual([{ type: "species", values: ["cat", "dog"] }]);
  });
});
