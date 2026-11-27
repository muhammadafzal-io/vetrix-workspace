import { describe, expect, it } from "vitest";
import { connectWithRetry, readableDbError } from "./neon-pool";

const noWait = async () => {};
const wsError = { type: "error", defaultPrevented: false }; // what a failed WebSocket reports

describe("opening database connections", () => {
  it("tries again when connecting fails, then succeeds", async () => {
    let calls = 0;
    const client = await connectWithRetry(async () => {
      calls++;
      if (calls < 3) throw wsError;
      return "client";
    }, noWait);
    expect(client).toBe("client");
    expect(calls).toBe(3);
  });

  it("gives up after three tries with a readable error", async () => {
    let calls = 0;
    const p = connectWithRetry(async () => {
      calls++;
      throw wsError;
    }, noWait);
    await expect(p).rejects.toThrow(/Could not connect to the database/);
    expect(calls).toBe(3);
  });

  it("keeps real errors as they are and names lost connections", () => {
    const real = new Error("password authentication failed");
    expect(readableDbError(real, "connect")).toBe(real);
    expect(readableDbError(wsError, "query").message).toMatch(/lost during a query/);
    expect(readableDbError({ error: new Error("ETIMEDOUT") }, "connect").message).toBe("Could not connect to the database: ETIMEDOUT");
  });
});
