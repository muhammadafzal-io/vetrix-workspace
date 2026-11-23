import { describe, expect, it } from "vitest";
import { ONBOARDING_STEPS, slugFromName, validateNewClinic } from "./clinic-setup";

const form = {
  clinicName: "  Paws & Claws   Vet ",
  slug: "",
  locationName: "",
  timezone: "America/Chicago",
  ownerName: "Dana Reyes",
  ownerEmail: " Dana@Example.COM ",
};

describe("adding a clinic", () => {
  it("cleans the input and fills the slug and location name from the clinic name", () => {
    expect(validateNewClinic(form)).toEqual({
      clinicName: "Paws & Claws Vet",
      slug: "paws-claws-vet",
      locationName: "Paws & Claws Vet",
      timezone: "America/Chicago",
      ownerName: "Dana Reyes",
      ownerEmail: "dana@example.com",
    });
  });

  it("makes safe slugs", () => {
    expect(slugFromName("Café Olé Animal Hospital!!")).toBe("cafe-ole-animal-hospital");
    expect(slugFromName("--Dr. Smith's  Vets--")).toBe("dr-smith-s-vets");
  });

  it("refuses bad slugs, reserved slugs, time zones and emails, naming the field", () => {
    const field = (f: Partial<typeof form>) => {
      try {
        validateNewClinic({ ...form, ...f });
      } catch (error) {
        return (error as { details?: { field?: string } }).details?.field;
      }
      return "accepted";
    };
    expect(field({ slug: "Bad Slug" })).toBe("slug");
    expect(field({ slug: "a-" })).toBe("slug");
    expect(field({ slug: "admin" })).toBe("slug");
    expect(field({ timezone: "Mars/Olympus" })).toBe("timezone");
    expect(field({ timezone: "EST" })).toBe("timezone");
    expect(field({ ownerEmail: "dana" })).toBe("ownerEmail");
    expect(field({ clinicName: "X" })).toBe("clinicName");
  });

  it("accepts region time zones and UTC", () => {
    expect(validateNewClinic({ ...form, timezone: "Asia/Karachi" }).timezone).toBe("Asia/Karachi");
    expect(validateNewClinic({ ...form, timezone: "UTC" }).timezone).toBe("UTC");
  });

  it("marks onboarding steps 1, 2, 3 and 7 as mandatory", () => {
    expect(ONBOARDING_STEPS.filter((s) => s.mandatory).map((s) => s.step)).toEqual([1, 2, 3, 7]);
  });
});
