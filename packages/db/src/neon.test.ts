import { describe, expect, it } from "vitest";
import { createNeonProject, NeonApiError, pooledConnectionString } from "./neon";

const direct = "postgresql://neondb_owner:pw@ep-cool-1.us-east-1.aws.neon.tech/neondb?sslmode=require";

function fakeNeon(statuses: string[], createStatus = 201) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  let i = 0;
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method ?? "GET", url, body: init.body ? JSON.parse(String(init.body)) : null });
    if (init.method === "POST") {
      if (createStatus !== 201) return new Response(JSON.stringify({ message: "project limit reached" }), { status: createStatus });
      return new Response(
        JSON.stringify({
          project: { id: "proj-1", region_id: "aws-us-east-1" },
          connection_uris: [{ connection_uri: direct, connection_parameters: { pooler_host: "ep-cool-1-pooler.us-east-1.aws.neon.tech" } }],
          operations: [{ id: "op-1", status: "running" }, { id: "op-2", status: "finished" }],
        }),
        { status: 201 },
      );
    }
    if (url.endsWith("/users/me/organizations")) return new Response(JSON.stringify({ organizations: [{ id: "org-1" }] }));
    return new Response(JSON.stringify({ operation: { status: statuses[Math.min(i++, statuses.length - 1)] } }));
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("Neon projects", () => {
  it("creates a project, waits for its operations and returns the pooled connection string", async () => {
    const { f, calls } = fakeNeon(["running", "finished"]);
    const p = await createNeonProject({ apiKey: "k", fetchImpl: f, pollMs: 0 }, { name: "vetrix-paws", region: "aws-us-east-1" });
    expect(p.projectId).toBe("proj-1");
    expect(p.pooledUrl).toContain("ep-cool-1-pooler.us-east-1.aws.neon.tech");
    // A personal key: the account's only organization is looked up and used.
    expect(calls[0]!.url).toMatch(/\/users\/me\/organizations$/);
    expect(calls[1]).toMatchObject({ method: "POST", body: { project: { name: "vetrix-paws", region_id: "aws-us-east-1", org_id: "org-1" } } });
    // Only the unfinished operation is polled, until it finishes.
    expect(calls.slice(2).every((c) => c.url.endsWith("/operations/op-1"))).toBe(true);
    expect(calls).toHaveLength(4);
  });

  it("uses a configured organization without looking it up", async () => {
    const { f, calls } = fakeNeon(["finished"]);
    await createNeonProject({ apiKey: "k", orgId: "org-set", fetchImpl: f, pollMs: 0 }, { name: "x", region: "aws-us-east-1" });
    expect(calls[0]).toMatchObject({ method: "POST", body: { project: { org_id: "org-set" } } });
  });

  it("explains a refusal from Neon, such as the plan's project limit", async () => {
    const { f } = fakeNeon([], 422);
    await expect(createNeonProject({ apiKey: "k", fetchImpl: f, pollMs: 0 }, { name: "x", region: "aws-us-east-1" })).rejects.toThrow(
      /Neon: project limit reached/,
    );
  });

  it("fails when Neon could not start the database", async () => {
    const { f } = fakeNeon(["failed"]);
    await expect(createNeonProject({ apiKey: "k", fetchImpl: f, pollMs: 0 }, { name: "x", region: "aws-us-east-1" })).rejects.toBeInstanceOf(NeonApiError);
  });

  it("swaps in the pooler host and keeps TLS on", () => {
    const u = pooledConnectionString("postgresql://a:b@ep-1.aws.neon.tech/neondb", "ep-1-pooler.aws.neon.tech");
    expect(u).toBe("postgresql://a:b@ep-1-pooler.aws.neon.tech/neondb?sslmode=require");
    expect(pooledConnectionString(direct, undefined)).toBe(direct);
  });
});
