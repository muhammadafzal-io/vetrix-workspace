import { describe, expect, it } from "vitest";
import { isBookingToken, spreadByDay } from "./online-booking";

const at = (iso: string) => Date.parse(iso);

describe("online booking", () => {
  it("groups by clinic day, one per start, and spreads a long day", () => {
    const slots = [
      ...Array.from({ length: 20 }, (_, i) => ({ start: at("2026-11-16T14:00:00Z") + i * 15 * 60_000, providerId: "a" })),
      { start: at("2026-11-16T14:00:00Z"), providerId: "b" },
      { start: at("2026-11-17T15:00:00Z"), providerId: "a" },
    ];
    const days = spreadByDay(slots, "America/New_York", 5);
    expect(days.map((d) => d.date)).toEqual(["2026-11-16", "2026-11-17"]);
    expect(days[0]!.times).toHaveLength(5);
    expect(days[0]!.times[0]!.start).toBe(at("2026-11-16T14:00:00Z"));
    expect(days[0]!.times.at(-1)!.start).toBe(at("2026-11-16T14:00:00Z") + 19 * 15 * 60_000);
    expect(days[0]!.times[0]!.providerId).toBe("a");
  });

  it("accepts only long random tokens", () => {
    expect(isBookingToken("Ab3_x-9QwErTyUiOp")).toBe(true);
    expect(isBookingToken("short")).toBe(false);
    expect(isBookingToken("bad/token/with/slash")).toBe(false);
  });
});
