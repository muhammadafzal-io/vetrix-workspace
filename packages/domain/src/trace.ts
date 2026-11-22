// Flow trace: a learning and debugging aid that prints each step a request
// takes through the code, layer by layer. Off unless FLOW_TRACE=1 (set it in
// apps/web/.env.local and restart `pnpm dev`).
//
// Privacy rule for every caller: pass ids, steps, levels and counts only.
// Never a name, phone number, email, message text, token or secret.

export type FlowLayer = "middleware" | "page" | "action" | "auth" | "tenancy" | "db" | "domain" | "ai";

const TAG: Record<FlowLayer, string> = {
  middleware: "MIDDLEWARE",
  page: "PAGE      ",
  action: "ACTION    ",
  auth: "AUTH      ",
  tenancy: "TENANCY   ",
  db: "DB        ",
  domain: "DOMAIN    ",
  ai: "AI        ",
};

/** True when FLOW_TRACE=1. Read on every call so a restart is the only step needed. */
export function flowOn(): boolean {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.FLOW_TRACE === "1";
}

function clock(): string {
  return new Date().toISOString().slice(11, 23);
}

/**
 * One step. `where` is "file › function", for example
 * "features/widget/actions.ts › chatSendAction".
 */
export function trace(layer: FlowLayer, where: string, message: string): void {
  if (!flowOn()) return;
  console.info(`[flow] ${clock()} ${TAG[layer]} ${where.padEnd(48)} ${message}`);
}

/**
 * A step that takes time: prints "→ message" before and "← result (ms)"
 * after, or "✗ ErrorName" when it throws.
 */
export async function traced<T>(layer: FlowLayer, where: string, message: string, fn: () => Promise<T>, done?: (result: T) => string): Promise<T> {
  if (!flowOn()) return fn();
  trace(layer, where, `→ ${message}`);
  const started = performance.now();
  try {
    const result = await fn();
    trace(layer, where, `← ${done ? done(result) : "done"} (${Math.round(performance.now() - started)} ms)`);
    return result;
  } catch (error) {
    trace(layer, where, `✗ ${(error as Error).name} (${Math.round(performance.now() - started)} ms)`);
    throw error;
  }
}
