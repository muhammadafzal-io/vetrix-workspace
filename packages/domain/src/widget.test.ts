import { describe, expect, it } from "vitest";
import { ValidationError } from "./errors";
import { canBookOnline, isWidgetCode, parseWidgetOrigins, validateNewClient } from "./widget";

describe("booking widget", () => {
  it("turns typed websites into frame origins", () => {
    expect(parseWidgetOrigins("happypaws.com, https://www.happypaws.com/book\nhttp://localhost:5500")).toEqual([
      "https://happypaws.com",
      "https://www.happypaws.com",
      "http://localhost:5500",
    ]);
    expect(parseWidgetOrigins("  ")).toEqual([]);
    expect(() => parseWidgetOrigins("http://happypaws.com")).toThrow(ValidationError);
    expect(() => parseWidgetOrigins("not a site")).toThrow(ValidationError);
    expect(() => parseWidgetOrigins("a.com b.com c.com d.com e.com f.com")).toThrow(/up to 5/);
  });

  it("never lets surgery, euthanasia or sick visits be booked online", () => {
    expect(canBookOnline({ packServiceId: "wellness_exam", category: "exam" })).toBe(true);
    expect(canBookOnline({ packServiceId: "spay_canine", category: "surgery" })).toBe(false);
    expect(canBookOnline({ packServiceId: "euthanasia", category: "exam" })).toBe(false);
    expect(canBookOnline({ packServiceId: "sick_visit", category: "exam" })).toBe(false);
  });

  it("accepts six-digit codes only", () => {
    expect(isWidgetCode("042137")).toBe(true);
    expect(isWidgetCode("42137")).toBe(false);
    expect(isWidgetCode("04213a")).toBe(false);
  });

  it("builds a new client and first pet from the form, with the verified mobile", () => {
    const { client, patient } = validateNewClient(
      { firstName: " Sam ", lastName: "Lee", email: "", smsConsent: true, petName: "Mochi", species: "cat", ageBand: "6m_2y", sex: "female" },
      "+15125550142",
      "2026-11-16",
    );
    expect(client).toMatchObject({ firstName: "Sam", mobile: "+15125550142", smsConsent: true, preferredChannel: "sms", email: null });
    expect(patient).toMatchObject({ name: "Mochi", species: "cat", approxAgeMonths: 12, sex: "female" });
    const noText = validateNewClient(
      { firstName: "Sam", lastName: "Lee", email: "sam@example.com", smsConsent: false, petName: "Mochi", species: "cat", ageBand: "not_sure", sex: null },
      "+15125550142",
      "2026-11-16",
    );
    expect(noText.client.preferredChannel).toBe("email");
    expect(noText.patient.approxAgeMonths).toBeNull();
    expect(() =>
      validateNewClient({ firstName: "", lastName: "Lee", smsConsent: true, petName: "Mochi", species: "cat", ageBand: "not_sure", sex: null }, "+15125550142", "2026-11-16"),
    ).toThrow(ValidationError);
  });
});
