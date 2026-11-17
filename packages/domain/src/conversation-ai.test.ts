import { describe, expect, it } from "vitest";
import { acceptRewrite, engineText, mustKeep, UNCLEAR, type RewriteRequest } from "./conversation-ai";

const req = (replies: string[], names: string[] = []): RewriteRequest => ({
  replies,
  keep: mustKeep(replies, names),
  aiName: "Riley",
  clinicName: "Main Veterinary Clinic",
  channel: "sms",
  callerText: "hi",
});

describe("conversation model: reading the owner's words", () => {
  it("adds the restatement on the open question, replaces it on focused ones, and ignores empty or runaway answers", () => {
    expect(engineText("can bella come in thurs, shes itchy", "I want to book a visit for Bella for itching on Thursday", true)).toBe(
      "can bella come in thurs, shes itchy\nI want to book a visit for Bella for itching on Thursday",
    );
    expect(engineText("the latter pls", "the second one", false)).toBe("the second one");
    expect(engineText("the second one", "The second one", false)).toBe("the second one");
    expect(engineText("yes", "", false)).toBe("yes");
    expect(engineText("yes", null, false)).toBe("yes");
    expect(engineText("yes", "x".repeat(500), false)).toBe("yes");
  });
});

describe("conversation model: focused steps accept only allowed answers", () => {
  const offer = ["the first one", "the second one", "none of those", UNCLEAR];
  const decline = "hmm neither really suits, got anything later on thurs?";

  it("never turns a no into a booking (regression: 'later than 12 PM' picked the 12 PM slot)", () => {
    expect(engineText(decline, "Thursday later than 12 PM", false, offer)).toBe(decline);
    expect(engineText(decline, "the first one", false, offer)).toBe(decline);
    expect(engineText(decline, "none of those", false, offer)).toBe(decline);
    expect(engineText("those both clash with work", "none of those", false, offer)).toBe("none of those");
    expect(engineText(decline, UNCLEAR, false, offer)).toBe(decline);
  });

  it("uses an allowed answer, tidied, and the owner's words for anything else", () => {
    expect(engineText("the latter pls", "The second one.", false, offer)).toBe("the second one");
    expect(engineText("yeah go on then", "yes", false, ["yes", "no", UNCLEAR])).toBe("yes");
    expect(engineText("nah not really", "yes", false, ["yes", "no", UNCLEAR])).toBe("nah not really");
    expect(engineText("she's a lizard", "reptile", false, ["dog", "cat", "rabbit", "bird", "reptile", "other", UNCLEAR])).toBe("reptile");
    expect(engineText("what time do you close?", "Thursday", false, offer)).toBe("what time do you close?");
  });
});

describe("conversation model: wording replies", () => {
  it("finds the facts a rewrite must keep", () => {
    const keep = mustKeep(["Max can come in Wednesday, Nov 18 at 9 AM or 2 PM with Dr. Lee. A late cancel is $35. Call (555) 010-1000."], ["Max", "Bella"]);
    expect(keep).toEqual(expect.arrayContaining(["9 AM", "2 PM", "$35", "(555) 010-1000", "Wednesday, Nov 18", "Max"]));
    expect(keep).not.toContain("Bella");
  });

  it("accepts a natural rewrite that keeps every fact", () => {
    const r = req(["I can do Wednesday, Nov 18 at 9 AM or 2 PM for Max.", "Which works better?"], ["Max"]);
    expect(acceptRewrite(r, "Good news: Max can come in Wednesday, Nov 18 at 9 AM or 2 PM. Which works better?")).toMatch(/^Good news/);
  });

  it("rejects a rewrite that drops or changes a time, adds a price or number, loses the question, or rambles", () => {
    const r = req(["I can do Wednesday, Nov 18 at 9 AM or 2 PM for Max.", "Which works better?"], ["Max"]);
    expect(acceptRewrite(r, "Max can come in Wednesday, Nov 18 at 9 AM. Which works better?")).toBeNull();
    expect(acceptRewrite(r, "Max can come in Wednesday, Nov 18 at 9 AM or 3 PM. Which works better?")).toBeNull();
    expect(acceptRewrite(r, "Max can come in Wednesday, Nov 18 at 9 AM or 2 PM, it's $60. Which works better?")).toBeNull();
    expect(acceptRewrite(r, "Max can come in Wednesday, Nov 18 at 9 AM or 2 PM.")).toBeNull();
    expect(acceptRewrite(r, `Max can come in Wednesday, Nov 18 at 9 AM or 2 PM. ${"Lovely. ".repeat(60)}Which works better?`)).toBeNull();
    expect(acceptRewrite(r, "")).toBeNull();
    expect(acceptRewrite(r, null)).toBeNull();
  });
});
