import { describe, expect, it } from "vitest";
import type { Permission } from "./access";
import {
  assertVisitChange,
  historyFiltersFor,
  historyKindsFor,
  validateVisitOutcome,
  vaccineDueDate,
  visitChangesFor,
} from "./patient-history";

const start = new Date("2026-11-23T15:00:00Z");
const after = new Date("2026-11-23T15:30:00Z");
const before = new Date("2026-11-23T14:00:00Z");

describe("visit status changes", () => {
  it("offers check-in, complete and no-show for a booked visit, nothing for a finished one", () => {
    expect(visitChangesFor("confirmed")).toEqual(["checked_in", "completed", "no_show"]);
    expect(visitChangesFor("checked_in")).toEqual(["completed"]);
    expect(visitChangesFor("completed")).toEqual([]);
    expect(visitChangesFor("cancelled")).toEqual([]);
    expect(visitChangesFor("no_show")).toEqual([]);
  });

  it("allows completing a visit that has started", () => {
    expect(() => assertVisitChange({ from: "checked_in", to: "completed", startAt: start, now: after })).not.toThrow();
    expect(() => assertVisitChange({ from: "confirmed", to: "completed", startAt: start, now: after })).not.toThrow();
  });

  it("refuses to complete or no-show a visit before it starts, but allows early check-in", () => {
    expect(() => assertVisitChange({ from: "confirmed", to: "completed", startAt: start, now: before })).toThrow("has not started");
    expect(() => assertVisitChange({ from: "confirmed", to: "no_show", startAt: start, now: before })).toThrow("has not started");
    expect(() => assertVisitChange({ from: "confirmed", to: "checked_in", startAt: start, now: before })).not.toThrow();
  });

  it("refuses changes from a finished visit", () => {
    expect(() => assertVisitChange({ from: "completed", to: "no_show", startAt: start, now: after })).toThrow("cannot be marked");
    expect(() => assertVisitChange({ from: "cancelled", to: "checked_in", startAt: start, now: after })).toThrow("cannot be marked");
    expect(() => assertVisitChange({ from: "checked_in", to: "no_show", startAt: start, now: after })).toThrow("cannot be marked");
  });
});

describe("visit outcome", () => {
  const dogVaccines = new Set(["rabies_1yr", "dhpp"]);

  it("accepts an empty outcome", () => {
    expect(validateVisitOutcome({}, dogVaccines)).toEqual({ weightKg: null, vaccineIds: [] });
  });

  it("rounds the weight, accepts a comma and removes repeated vaccines", () => {
    expect(validateVisitOutcome({ weightKg: " 12,345 ", vaccineIds: ["dhpp", "dhpp"] }, dogVaccines)).toEqual({ weightKg: 12.35, vaccineIds: ["dhpp"] });
  });

  it("refuses impossible weights and vaccines for another species", () => {
    expect(() => validateVisitOutcome({ weightKg: "0" }, dogVaccines)).toThrow("between 0.05 and 150");
    expect(() => validateVisitOutcome({ weightKg: "400" }, dogVaccines)).toThrow("between 0.05 and 150");
    expect(() => validateVisitOutcome({ weightKg: "heavy" }, dogVaccines)).toThrow("between 0.05 and 150");
    expect(() => validateVisitOutcome({ vaccineIds: ["fvrcp"] }, dogVaccines)).toThrow("this pet's species");
  });
});

describe("vaccineDueDate", () => {
  it("adds months and clamps to the end of a shorter month", () => {
    expect(vaccineDueDate("2026-11-23", 12)).toBe("2027-11-23");
    expect(vaccineDueDate("2026-01-31", 1)).toBe("2026-02-28");
    expect(vaccineDueDate("2027-12-31", 2)).toBe("2028-02-29");
    expect(vaccineDueDate("2026-03-15", 36)).toBe("2029-03-15");
  });
});

describe("history kinds and permissions", () => {
  const front = new Set<Permission>(["patients.view", "calls.view", "messages.view", "tasks.view"]);
  const tech = new Set<Permission>(["patients.view"]);

  it("shows everything to someone with every permission", () => {
    expect(historyKindsFor(front)).toEqual(["visit", "vaccine", "prevention", "weight", "call", "message", "task"]);
  });

  it("hides calls, texts and tasks without their permission", () => {
    expect(historyKindsFor(tech)).toEqual(["visit", "vaccine", "prevention", "weight"]);
    expect(historyKindsFor(tech, "calls")).toEqual([]);
    expect(historyFiltersFor(tech).map((f) => f.id)).toEqual(["all", "visits", "health"]);
  });

  it("falls back to All for an unknown filter", () => {
    expect(historyKindsFor(front, "nonsense")).toEqual(historyKindsFor(front, "all"));
  });
});
