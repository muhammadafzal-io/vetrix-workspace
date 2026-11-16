// Online booking from a personal link (the {{booking_link}} in reminders).
// The client picks a time for a visit the link already names; the same
// booking rules as Riley apply (strict: anything needing staff judgement
// sends them to the phone instead).
import { localParts } from "./time";

export const ONLINE_BOOKING = {
  /** A link works this long after it is sent (covers the whole reminder sequence). */
  expiresDays: 45,
  /** Days of times shown. */
  searchDays: 21,
  /** Earliest start: not within the next two hours. */
  leadMinutes: 120,
  /** Times shown per day, spread across the day. */
  perDay: 8,
  /** Days with times shown. */
  maxDays: 10,
} as const;

/** Pack rule → the visit its link books ("same_as_missed_appointment" is resolved from the missed visit). */
export function serviceForRule(rule: { books_service?: string | null } | undefined): string | null {
  return rule?.books_service ?? null;
}

export interface DayTimes<T extends { start: number }> {
  date: string;
  times: T[];
}

/**
 * Groups times by clinic day and keeps a spread of them per day (morning to
 * evening), so a long list fits on a phone. One time per start (the first provider).
 */
export function spreadByDay<T extends { start: number }>(slots: T[], timezone: string, perDay: number = ONLINE_BOOKING.perDay, maxDays: number = ONLINE_BOOKING.maxDays): DayTimes<T>[] {
  const days = new Map<string, T[]>();
  const seen = new Set<number>();
  for (const s of [...slots].sort((a, b) => a.start - b.start)) {
    if (seen.has(s.start)) continue;
    seen.add(s.start);
    const d = localParts(s.start, timezone).date;
    (days.get(d) ?? days.set(d, []).get(d)!).push(s);
  }
  return [...days.entries()].slice(0, maxDays).map(([date, all]) => {
    if (all.length <= perDay) return { date, times: all };
    const step = (all.length - 1) / (perDay - 1);
    const picked = [...new Set(Array.from({ length: perDay }, (_, i) => Math.round(i * step)))].map((i) => all[i]!);
    return { date, times: picked };
  });
}

/** A random URL-safe token check (16+ characters from the link). */
export function isBookingToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{16,64}$/.test(token);
}
