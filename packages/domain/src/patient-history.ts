// Patient history at the front desk: which visit status changes are allowed,
// what staff may record when a visit is completed, and what the History tab
// shows. Not a clinical record: diagnoses, notes and prescriptions stay in
// the clinic's PIMS, except the visit records added 26 Nov 2026
// (notes, recommendations, prescriptions, photos: ./visit-records.ts).
import { RuleViolationError, ValidationError } from "./errors";
import type { Permission } from "./access";

export type VisitStatus = "requested" | "confirmed" | "checked_in" | "in_progress" | "completed" | "no_show" | "cancelled";

/** The changes staff make from the schedule. Cancelling has its own flow. */
export type VisitChange = "checked_in" | "completed" | "no_show";

const ALLOWED: Record<VisitChange, readonly VisitStatus[]> = {
  checked_in: ["requested", "confirmed"],
  // A visit can be completed straight from booked: small clinics often skip check-in.
  completed: ["requested", "confirmed", "checked_in", "in_progress"],
  no_show: ["requested", "confirmed"],
};

/** The changes offered for a visit in this status, in the order the buttons show. */
export function visitChangesFor(status: string): VisitChange[] {
  return (["checked_in", "completed", "no_show"] as const).filter((c) => (ALLOWED[c] as readonly string[]).includes(status));
}

/**
 * Throws unless the change is allowed now. A visit cannot be completed or
 * marked a no-show before it starts (in the clinic's time, given as `now`).
 */
export function assertVisitChange(input: { from: string; to: VisitChange; startAt: Date; now: Date }): void {
  if (!(ALLOWED[input.to] as readonly string[]).includes(input.from)) {
    throw new RuleViolationError("visit.status", `This visit is ${input.from.replace("_", " ")}, so it cannot be marked ${input.to.replace("_", " ")}.`);
  }
  if ((input.to === "completed" || input.to === "no_show") && input.startAt.getTime() > input.now.getTime()) {
    throw new RuleViolationError("visit.not_started", "This visit has not started yet.");
  }
}

export interface VisitOutcomeInput {
  /** Text from the form; empty means not weighed. */
  weightKg?: string | null;
  /** vaccine_types ids given at this visit. */
  vaccineIds?: string[];
}

export interface ValidVisitOutcome {
  weightKg: number | null;
  vaccineIds: string[];
}

/** Checks what staff record when completing a visit. `allowedVaccines` are the ids for this pet's species. */
export function validateVisitOutcome(input: VisitOutcomeInput, allowedVaccines: ReadonlySet<string>): ValidVisitOutcome {
  let weightKg: number | null = null;
  const raw = (input.weightKg ?? "").trim();
  if (raw) {
    const n = Number(raw.replace(",", "."));
    if (!Number.isFinite(n) || n < 0.05 || n > 150) {
      throw new ValidationError("Enter a weight between 0.05 and 150 kg.", { field: "weightKg" });
    }
    weightKg = Math.round(n * 100) / 100;
  }
  const vaccineIds = [...new Set(input.vaccineIds ?? [])];
  for (const id of vaccineIds) {
    if (!allowedVaccines.has(id)) throw new ValidationError("Choose vaccines for this pet's species.", { field: "vaccineIds" });
  }
  return { weightKg, vaccineIds };
}

/** Next due date of a vaccine given on `given` (YYYY-MM-DD), `months` later. Month ends clamp (31 Jan + 1 → 28/29 Feb). */
export function vaccineDueDate(given: string, months: number): string {
  const [y, m, d] = given.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

// ---------- The History tab ----------

export const HISTORY_KINDS = ["visit", "vaccine", "prevention", "weight", "call", "message", "task"] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

/**
 * Where an entry comes from, shown on every timeline row so nobody mistakes
 * what an owner said or what the AI judged for something the clinic recorded.
 */
export type HistorySource = "clinic" | "owner" | "ai" | "system";

export const HISTORY_SOURCE_LABEL: Record<HistorySource, string> = {
  clinic: "Clinic record",
  owner: "Owner said",
  ai: "AI",
  system: "Automatic",
};

/** Filter chips on the History tab, with the kinds each one shows. */
export const HISTORY_FILTERS = [
  { id: "all", label: "All", kinds: HISTORY_KINDS },
  { id: "visits", label: "Visits", kinds: ["visit"] },
  { id: "health", label: "Vaccines and weight", kinds: ["vaccine", "prevention", "weight"] },
  { id: "calls", label: "Calls", kinds: ["call"] },
  { id: "messages", label: "Texts and emails", kinds: ["message"] },
  { id: "tasks", label: "Tasks", kinds: ["task"] },
] as const satisfies readonly { id: string; label: string; kinds: readonly HistoryKind[] }[];
export type HistoryFilterId = (typeof HISTORY_FILTERS)[number]["id"];

const KIND_PERMISSION: Partial<Record<HistoryKind, Permission>> = {
  call: "calls.view",
  message: "messages.view",
  task: "tasks.view",
};

/** The kinds this person may see: calls, texts and tasks need their own permission. */
export function historyKindsFor(permissions: ReadonlySet<Permission>, filter: string = "all"): HistoryKind[] {
  const chosen = HISTORY_FILTERS.find((f) => f.id === filter) ?? HISTORY_FILTERS[0];
  return (chosen.kinds as readonly HistoryKind[]).filter((k) => {
    const needs = KIND_PERMISSION[k];
    return !needs || permissions.has(needs);
  });
}

/** Filter chips worth showing: those with at least one kind the person may see. */
export function historyFiltersFor(permissions: ReadonlySet<Permission>) {
  return HISTORY_FILTERS.filter((f) => historyKindsFor(permissions, f.id).length > 0);
}
