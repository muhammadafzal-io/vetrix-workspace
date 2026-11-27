import { describe, expect, it } from "vitest";
import {
  acceptParsedPrescription,
  acceptTidiedNote,
  buildPrescriptionParsePrompt,
  buildTidyNotePrompt,
  checkDraftAgainst,
  numbersIn,
  sandboxParsePrescription,
} from "./visit-records-ai";

const note = "nails done. red btwn toes LF, owner says licking 3d. cleaned w chlorhexidine";

describe("checking an AI draft against what staff wrote", () => {
  it("accepts a tidied note that only restates the original", () => {
    const draft = "Owner reports: licking the paw for 3 days.\nFindings: redness between the toes of the left front leg.\nDone: nails trimmed; area cleaned with chlorhexidine.";
    expect(acceptTidiedNote(note, draft)?.text).toBe(draft);
  });

  it("refuses a draft that adds a number", () => {
    expect(checkDraftAgainst(note, "Licking for 5 days.").problems).toContain("number 5 is not in the original");
    expect(checkDraftAgainst(note, "Licking for five days.").ok).toBe(false);
    expect(acceptTidiedNote(note, "Owner reports licking for 3 days; weight 21 kg.")).toBeNull();
  });

  it("refuses a draft that adds a medicine or a diagnosis", () => {
    expect(checkDraftAgainst(note, "Start carprofen.").problems).toContain('"carprofen" is not in the original');
    expect(checkDraftAgainst(note, "Findings: pododermatitis.").ok).toBe(false);
    expect(checkDraftAgainst(note, "Likely an allergy.").problems).toContain("adds a diagnosis or a guess");
    expect(checkDraftAgainst(note, "Consistent with a foreign body.").ok).toBe(false);
  });

  it("allows everyday words that look like medical terms, and words staff already used", () => {
    expect(checkDraftAgainst("routine nail trim, canine patient", "Routine nail trim for a canine patient.").ok).toBe(true);
    expect(checkDraftAgainst("suspect otitis", "Suspected otitis.").ok).toBe(true);
  });

  it("refuses empty or runaway drafts", () => {
    expect(acceptTidiedNote(note, "")).toBeNull();
    expect(acceptTidiedNote(note, 42)).toBeNull();
    expect(acceptTidiedNote("short", "word ".repeat(200))).toBeNull();
  });

  it("normalizes numbers", () => {
    expect([...numbersIn("7.50 mg, 1,000 IU, 3d")].sort()).toEqual(["1000", "3", "7.5"]);
  });
});

describe("reading a prescription line", () => {
  const line = "carprofen 75mg 1 tab po bid x7d #14";

  it("keeps fields whose medicine and numbers come from the text", () => {
    expect(
      acceptParsedPrescription(line, {
        drug_name: "Carprofen", strength: "75 mg", dose: "1 tablet", route: "oral", frequency: "Twice a day",
        duration_days: "7", quantity: "14 tablets", refills: "",
      }),
    ).toEqual({ drugName: "Carprofen", strength: "75 mg", dose: "1 tablet", route: "oral", frequency: "Twice a day", durationDays: "7", quantity: "14 tablets", refills: "" });
  });

  it("drops a medicine that is not in the text and numbers it made up", () => {
    const parsed = acceptParsedPrescription(line, {
      drug_name: "Meloxicam", strength: "100 mg", dose: "2 tablets", route: "oral", frequency: "Twice a day",
      duration_days: "10", quantity: "14 tablets", refills: "3",
    });
    expect(parsed).toMatchObject({ drugName: "", strength: "", dose: "", durationDays: "", refills: "", quantity: "14 tablets", frequency: "Twice a day" });
  });

  it("turns weeks into days but nothing else", () => {
    expect(acceptParsedPrescription("amoxicillin 250mg bid 2 weeks", { drug_name: "amoxicillin", strength: "250 mg", dose: "", route: "", frequency: "Twice a day", duration_days: "14", quantity: "", refills: "" })?.durationDays).toBe("14");
  });

  it("ignores unknown routes and returns null when nothing is usable", () => {
    expect(acceptParsedPrescription(line, { drug_name: "x", strength: "", dose: "", route: "nasal", frequency: "", duration_days: "", quantity: "", refills: "" })).toBeNull();
    expect(acceptParsedPrescription(line, null)).toBeNull();
  });
});

describe("sandbox prescription reading (no AI key)", () => {
  it("reads common shorthand", () => {
    expect(sandboxParsePrescription("carprofen 75mg 1 tab po bid x7d #14")).toEqual({
      drugName: "carprofen", strength: "75 mg", dose: "1 tablet", route: "oral", frequency: "Twice a day", durationDays: "7", quantity: "14 tablets", refills: "",
    });
    expect(sandboxParsePrescription("Apoquel 16 mg 1/2 tab sid 2 weeks 1 refill")).toMatchObject({ drugName: "Apoquel", strength: "16 mg", frequency: "Once a day", durationDays: "14", refills: "1" });
    expect(sandboxParsePrescription("otic drops 3 drops au bid for 10 days")).toMatchObject({ dose: "3 drops", route: "otic", durationDays: "10" });
  });
  it("returns null for empty text", () => {
    expect(sandboxParsePrescription("  ")).toBeNull();
  });
});

describe("prompts", () => {
  it("send only the typed text and the species, and forbid adding anything", () => {
    const p = buildTidyNotePrompt({ kind: "note", text: note, species: "dog" });
    expect(p.user).toBe(note);
    expect(p.system).toMatch(/Never add anything/);
    expect(buildPrescriptionParsePrompt(note).system).toMatch(/never choose a medicine or a dose/i);
  });
});
