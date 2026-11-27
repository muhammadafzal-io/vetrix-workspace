import { describe, expect, it } from "vitest";
import { RuleViolationError, ValidationError } from "./errors";
import { ROLES } from "./access";
import {
  assertCanEditEntry,
  assertVisitAcceptsRecords,
  detectPhotoType,
  validatePrescription,
  validateVisitEntry,
  validateVisitPhoto,
  validateVoidReason,
  visitPhotoKeys,
} from "./visit-records";

const today = "2026-11-26";
const doctor = "11111111-1111-4111-8111-111111111111";
const doctors = new Set([doctor]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);

describe("which visits accept records", () => {
  it("accepts checked-in, in-progress and completed visits", () => {
    for (const s of ["checked_in", "in_progress", "completed"]) expect(() => assertVisitAcceptsRecords(s)).not.toThrow();
  });
  it("refuses visits that did not happen or have not started", () => {
    for (const s of ["requested", "confirmed", "cancelled", "no_show"]) expect(() => assertVisitAcceptsRecords(s)).toThrow(RuleViolationError);
  });
});

describe("notes and recommendations", () => {
  it("trims the text and keeps a follow-up date on a recommendation", () => {
    expect(validateVisitEntry({ kind: "recommendation", body: "  Recheck the ear  ", followUpOn: "2026-12-10" }, today)).toEqual({
      kind: "recommendation",
      body: "Recheck the ear",
      followUpOn: "2026-12-10",
    });
  });
  it("refuses empty text, unknown kinds and over-long text", () => {
    expect(() => validateVisitEntry({ kind: "note", body: "   " }, today)).toThrow(ValidationError);
    expect(() => validateVisitEntry({ kind: "diagnosis", body: "x" }, today)).toThrow(ValidationError);
    expect(() => validateVisitEntry({ kind: "note", body: "x".repeat(10_001) }, today)).toThrow(ValidationError);
  });
  it("allows a follow-up date only on recommendations, today or later, within two years, and real", () => {
    expect(() => validateVisitEntry({ kind: "note", body: "x", followUpOn: "2026-12-01" }, today)).toThrow(/Only a recommendation/);
    expect(() => validateVisitEntry({ kind: "recommendation", body: "x", followUpOn: "2026-11-25" }, today)).toThrow(/past/);
    expect(() => validateVisitEntry({ kind: "recommendation", body: "x", followUpOn: "2029-01-01" }, today)).toThrow(/two years/);
    expect(() => validateVisitEntry({ kind: "recommendation", body: "x", followUpOn: "2026-02-30" }, today)).toThrow(/valid/);
    expect(validateVisitEntry({ kind: "recommendation", body: "x", followUpOn: today }, today).followUpOn).toBe(today);
  });
});

describe("editing and removing", () => {
  const created = new Date("2026-11-26T10:00:00Z");
  const author = "a1";
  it("lets the author edit within 24 hours", () => {
    expect(() => assertCanEditEntry({ authorId: author, actorId: author, createdAt: created, now: new Date("2026-11-27T09:59:00Z"), voided: false })).not.toThrow();
  });
  it("refuses someone else, an expired window and a removed entry", () => {
    expect(() => assertCanEditEntry({ authorId: author, actorId: "b2", createdAt: created, now: created, voided: false })).toThrow(/Only the person/);
    expect(() => assertCanEditEntry({ authorId: author, actorId: null, createdAt: created, now: created, voided: false })).toThrow(/Only the person/);
    expect(() => assertCanEditEntry({ authorId: author, actorId: author, createdAt: created, now: new Date("2026-11-27T10:01:00Z"), voided: false })).toThrow(/24 hours/);
    expect(() => assertCanEditEntry({ authorId: author, actorId: author, createdAt: created, now: created, voided: true })).toThrow(/removed/);
  });
  it("needs a reason to remove", () => {
    expect(() => validateVoidReason(" ")).toThrow(ValidationError);
    expect(validateVoidReason(" Wrong pet ")).toBe("Wrong pet");
  });
});

describe("prescriptions", () => {
  const base = { drugName: "Carprofen", strength: "75 mg", dose: "1 tablet", route: "oral", frequency: "Twice a day", durationDays: "7", refills: "", prescribedBy: doctor };
  it("cleans a valid prescription", () => {
    expect(validatePrescription(base, doctors)).toEqual({
      drugName: "Carprofen",
      strength: "75 mg",
      dose: "1 tablet",
      route: "oral",
      frequency: "Twice a day",
      durationDays: 7,
      quantity: null,
      refills: 0,
      instructions: null,
      controlled: false,
      prescribedBy: doctor,
    });
  });
  it("needs medicine, dose, how often and a doctor of this clinic", () => {
    expect(() => validatePrescription({ ...base, drugName: "" }, doctors)).toThrow(/medicine name/);
    expect(() => validatePrescription({ ...base, dose: "" }, doctors)).toThrow(/dose/);
    expect(() => validatePrescription({ ...base, frequency: "" }, doctors)).toThrow(/how often/);
    expect(() => validatePrescription({ ...base, prescribedBy: "22222222-2222-4222-8222-222222222222" }, doctors)).toThrow(/doctor/);
  });
  it("refuses unknown routes and bad numbers", () => {
    expect(() => validatePrescription({ ...base, route: "nasal" }, doctors)).toThrow(/how it is given/);
    expect(() => validatePrescription({ ...base, durationDays: "2.5" }, doctors)).toThrow(/whole number/);
    expect(() => validatePrescription({ ...base, refills: "13" }, doctors)).toThrow(/Refills/);
  });
});

describe("photos", () => {
  it("detects the type from the bytes, not the name", () => {
    expect(detectPhotoType(jpeg)).toBe("image/jpeg");
    expect(detectPhotoType(png)).toBe("image/png");
    expect(detectPhotoType(webp)).toBe("image/webp");
    expect(detectPhotoType(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
    expect(detectPhotoType(new TextEncoder().encode("%PDF-1.7"))).toBeNull();
  });
  it("refuses empty, non-image, too many and over-size uploads", () => {
    expect(() => validateVisitPhoto({ bytes: new Uint8Array(), existingCount: 0 })).toThrow(/Choose a photo/);
    expect(() => validateVisitPhoto({ bytes: new TextEncoder().encode("GIF89a"), existingCount: 0 })).toThrow(/JPEG, PNG or WebP/);
    expect(() => validateVisitPhoto({ bytes: jpeg, existingCount: 20 })).toThrow(RuleViolationError);
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(jpeg);
    expect(() => validateVisitPhoto({ bytes: big, existingCount: 0 })).toThrow(/10 MB/);
  });
  it("keeps the body area and caption", () => {
    expect(validateVisitPhoto({ bytes: jpeg, bodyArea: " Left front paw ", caption: "", existingCount: 3 })).toEqual({
      type: "image/jpeg",
      bodyArea: "Left front paw",
      caption: null,
    });
  });
  it("builds storage keys from ids only", () => {
    const id = "33333333-3333-4333-8333-333333333333";
    expect(visitPhotoKeys({ organizationId: id, locationId: id, patientId: id, photoId: id }).thumb).toMatch(/visit-photos\/3{8}-.*-thumb\.jpg$/);
    expect(() => visitPhotoKeys({ organizationId: "../x", locationId: id, patientId: id, photoId: id })).toThrow();
  });
});

describe("who may see and write records", () => {
  it("gives prescribing to doctors and owners only", () => {
    const prescribers = Object.entries(ROLES).filter(([, r]) => r.permissions.includes("records.prescribe")).map(([k]) => k).sort();
    expect(prescribers).toEqual(["dvm", "owner"]);
  });
  it("keeps records away from assistants and client service by default", () => {
    for (const key of ["assistant", "csr"] as const) {
      expect(ROLES[key].permissions.some((p) => p.startsWith("records."))).toBe(false);
    }
  });
});
