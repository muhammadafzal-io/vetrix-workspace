// AI help on visit records, with a fake OpenAI. Environment is set before the
// first getEnv() call (it is read once per process).
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  Object.assign(process.env, {
    REGISTRY_DATABASE_URL: "postgresql://u:p@localhost/registry",
    BETTER_AUTH_SECRET: "x".repeat(32),
    OPENAI_API_KEY: "test-key",
    OPENAI_TEXT_MODEL: "test-model",
  });
});

function fakeOpenAi(answer: unknown) {
  const calls: Record<string, unknown>[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
  }) as unknown as typeof fetch;
  return { f, calls };
}

const failing = (async () => new Response("down", { status: 500 })) as unknown as typeof fetch;

describe("tidyVisitNote", () => {
  it("returns a draft that only restates the note, sending just the text and species", async () => {
    const { tidyVisitNote } = await import("./ai");
    const { f, calls } = fakeOpenAi({ text: "Findings: redness between the toes of the left front leg for 3 days." });
    const draft = await tidyVisitNote({ kind: "note", text: "red btwn toes LF 3d", species: "dog" }, f);
    expect(draft).toBe("Findings: redness between the toes of the left front leg for 3 days.");
    const body = calls[0]!;
    expect(body.prompt_cache_key).toBe("vetrix-visit-tidy");
    expect((body.messages as { content: string }[])[1]!.content).toBe("red btwn toes LF 3d");
  });

  it("drops a draft that adds a medicine, and returns null when OpenAI fails", async () => {
    const { tidyVisitNote } = await import("./ai");
    const { f } = fakeOpenAi({ text: "Redness between toes for 3 days. Start carprofen." });
    expect(await tidyVisitNote({ kind: "note", text: "red btwn toes 3d", species: "dog" }, f)).toBeNull();
    expect(await tidyVisitNote({ kind: "note", text: "red btwn toes 3d", species: "dog" }, failing)).toBeNull();
  });
});

describe("readPrescriptionLine", () => {
  it("uses the model's fields that pass the check", async () => {
    const { readPrescriptionLine } = await import("./ai");
    const { f } = fakeOpenAi({ drug_name: "carprofen", strength: "75 mg", dose: "1 tablet", route: "oral", frequency: "Twice a day", duration_days: "7", quantity: "14 tablets", refills: "" });
    const r = await readPrescriptionLine("carprofen 75mg 1 tab po bid x7d #14", f);
    expect(r).toEqual({ source: "ai", fields: { drugName: "carprofen", strength: "75 mg", dose: "1 tablet", route: "oral", frequency: "Twice a day", durationDays: "7", quantity: "14 tablets", refills: "" } });
  });

  it("falls back to the Sandbox rules when OpenAI fails", async () => {
    const { readPrescriptionLine } = await import("./ai");
    const r = await readPrescriptionLine("carprofen 75mg 1 tab bid x7d", failing);
    expect(r?.source).toBe("sandbox");
    expect(r?.fields).toMatchObject({ drugName: "carprofen", strength: "75 mg", frequency: "Twice a day", durationDays: "7" });
  });
});
