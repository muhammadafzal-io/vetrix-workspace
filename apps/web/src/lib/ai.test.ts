import { describe, expect, it } from "vitest";
import { createOpenAiClassifier } from "./ai";
import type { Logger } from "./logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

function fakeOpenAi(answer: unknown, status = 200) {
  const calls: { body: Record<string, unknown> }[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    calls.push({ body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("OpenAI triage classifier", () => {
  it("raises the level when the model understands what the phrases miss", async () => {
    const { f, calls } = fakeOpenAi({ level: "emergency", trigger_ids: ["toxin_ingestion"], evidence: "ate my sugar-free mints", unsure: false });
    const classify = createOpenAiClassifier({ apiKey: "k", model: "m" }, quiet, f);
    const a = await classify("he ate my mints, the sugar-free ones", ["Max"]);
    expect(a.level).toBe("emergency");
    expect(calls[0]!.body.model).toBe("m");
    expect((calls[0]!.body.messages as { content: string }[])[1]!.content).toContain('"Max"');
  });

  it("sends the triage cache key and logs token counts only", async () => {
    const logged: Record<string, unknown>[] = [];
    const log = { ...quiet, info: (m: string, fields: Record<string, unknown>) => m === "ai usage" && logged.push(fields) } as unknown as Logger;
    const calls: { body: Record<string, unknown> }[] = [];
    const f = (async (_url: string, init: RequestInit) => {
      calls.push({ body: JSON.parse(String(init.body)) });
      const content = JSON.stringify({ level: "routine", trigger_ids: [], evidence: "", unsure: false });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 1350, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 1280 } },
        }),
      );
    }) as unknown as typeof fetch;
    await createOpenAiClassifier({ apiKey: "k", model: "m" }, log, f)("book a checkup", ["Max"]);
    expect(calls[0]!.body.prompt_cache_key).toBe("vetrix-triage");
    expect(logged).toEqual([{ call: "triage", input: 1350, cached: 1280, output: 40 }]);
  });

  it("never lowers what the pack phrases found", async () => {
    const { f } = fakeOpenAi({ level: "routine", trigger_ids: [], evidence: "", unsure: false });
    const a = await createOpenAiClassifier({ apiKey: "k", model: "m" }, quiet, f)("she is having a seizure", []);
    expect(a.level).toBe("emergency");
  });

  it("falls back to the phrase rules when OpenAI fails", async () => {
    const { f } = fakeOpenAi({}, 500);
    const a = await createOpenAiClassifier({ apiKey: "k", model: "m" }, quiet, f)("he keeps throwing up", []);
    expect(a.level).toBe("urgent");
    const down = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    expect((await createOpenAiClassifier({ apiKey: "k", model: "m" }, quiet, down)("book a checkup", [])).level).toBe("routine");
  });
});
