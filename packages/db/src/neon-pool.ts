// Connection pools for Neon over WebSockets, set up the way Neon documents
// for long-running Node servers.
//
// 1. WebSockets come from the `ws` package, not Node's built-in one. A failed
//    built-in connection only reported "[object ErrorEvent]" and was less
//    reliable on slow links.
// 2. Opening a connection is tried up to three times. Nothing has been sent to
//    the database at that point, so trying again can never save anything
//    twice. A query that fails after it was sent is never retried: the error
//    goes to the caller (it may have run).
// 3. A connection that fails during a query is thrown away, not reused.
import { neonConfig, Pool, type PoolClient, type PoolConfig } from "@neondatabase/serverless";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

export const CONNECT_ATTEMPTS = 3;
const RETRY_WAIT_MS = [250, 750];

/** Turns WebSocket error events (no message) into normal errors that say what failed. */
export function readableDbError(error: unknown, step: "connect" | "query"): Error {
  if (error instanceof Error) return error;
  const e = error as { message?: string; error?: unknown; type?: string } | null;
  const inner = e?.error instanceof Error ? e.error.message : e?.message;
  const what = step === "connect" ? "Could not connect to the database" : "The database connection was lost during a query";
  return new Error(inner ? `${what}: ${inner}` : `${what} (network error${e?.type ? `: ${e.type}` : ""}).`, { cause: error });
}

/** Opens a connection, trying again after a short wait when the network fails. */
export async function connectWithRetry<C>(connect: () => Promise<C>, wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<C> {
  let last: unknown;
  for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
    try {
      return await connect();
    } catch (error) {
      last = error;
      if (attempt < CONNECT_ATTEMPTS - 1) await wait(RETRY_WAIT_MS[attempt] ?? 750);
    }
  }
  throw readableDbError(last, "connect");
}

/** A pool whose `connect()` and `query()` use the retry and error rules above. */
export function createNeonPool(config: PoolConfig): Pool {
  const pool = new Pool(config);
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  const connectRetrying = () => connectWithRetry(() => connect() as Promise<PoolClient>);
  (pool as unknown as { connect: (...args: unknown[]) => unknown }).connect = (...args: unknown[]) =>
    args.length > 0 ? connect(...args) : connectRetrying();
  (pool as unknown as { query: (...args: unknown[]) => unknown }).query = async (...args: unknown[]) => {
    // pg's callback form is left as it is (nothing in Vetrix uses it).
    if (typeof args[args.length - 1] === "function") return (Pool.prototype.query as (...a: unknown[]) => unknown).apply(pool, args);
    const client = await connectRetrying();
    try {
      const result = await (client.query as (...a: unknown[]) => Promise<unknown>)(...args);
      client.release();
      return result;
    } catch (error) {
      // A broken connection is closed instead of going back to the pool.
      const broken = !(error instanceof Error);
      client.release(broken ? true : undefined);
      throw broken ? readableDbError(error, "query") : error;
    }
  };
  return pool;
}
