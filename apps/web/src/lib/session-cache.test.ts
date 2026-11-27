import { describe, expect, it } from "vitest";
import { createSessionStore } from "./session-cache";

describe("session store", () => {
  const t0 = 1_000_000;

  it("keeps a checked session for at most a minute", () => {
    const s = createSessionStore<string>(60_000);
    s.set("tok", "user-1", t0 + 7 * 86_400_000, t0);
    expect(s.get("tok", t0 + 59_999)).toBe("user-1");
    expect(s.get("tok", t0 + 60_000)).toBeUndefined();
  });

  it("never past the session's own expiry, and not at all once expired", () => {
    const s = createSessionStore<string>(60_000);
    s.set("soon", "user-1", t0 + 10_000, t0);
    expect(s.get("soon", t0 + 10_000)).toBeUndefined();
    s.set("gone", "user-2", new Date(t0 - 1), t0);
    expect(s.get("gone", t0)).toBeUndefined();
  });

  it("only answers for the exact cookie value, and stays bounded", () => {
    const s = createSessionStore<string>(60_000, 2);
    s.set("a", "1", t0 + 1e9, t0);
    s.set("b", "2", t0 + 1e9, t0);
    s.set("c", "3", t0 + 1e9, t0);
    expect(s.get("a", t0)).toBeUndefined(); // oldest dropped
    expect(s.get("c", t0)).toBe("3");
    expect(s.get("C", t0)).toBeUndefined();
  });
});
