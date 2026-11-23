// Neon API: creates the Neon project that holds one clinic's database.
// One project per clinic gives each clinic its own compute and lets it be
// suspended, restored or deleted on its own.
//
// API reference: POST https://console.neon.tech/api/v2/projects. The reply
// lists "operations" (create the branch, start the compute) that must finish
// before the database accepts connections, so they are polled.

const API = "https://console.neon.tech/api/v2";

export class NeonApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "NeonApiError";
  }
}

export interface NeonProject {
  projectId: string;
  /** Pooled connection string (pgbouncer host), for the app's short queries. */
  pooledUrl: string;
  region: string;
}

interface CreateProjectReply {
  project?: { id?: string; region_id?: string };
  connection_uris?: { connection_uri?: string; connection_parameters?: { host?: string; pooler_host?: string } }[];
  operations?: { id?: string; status?: string }[];
}

export interface NeonOptions {
  apiKey: string;
  /**
   * The Neon organization to create clinic projects in. A personal API key on
   * an account with organizations must name one. Unset: the account's only
   * organization is used, if it has exactly one; organization keys need none.
   */
  orgId?: string;
  fetchImpl?: typeof fetch;
  /** Pause between operation checks. Tests pass 0. */
  pollMs?: number;
  /** Give up waiting for operations after this long. */
  timeoutMs?: number;
}

async function call<T>(options: NeonOptions, method: string, path: string, body?: unknown): Promise<T> {
  const f = options.fetchImpl ?? fetch;
  const res = await f(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${options.apiKey}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) {
    // Neon's message explains limits and bad input; it never contains our key.
    const reason = typeof json.message === "string" ? json.message : `HTTP ${res.status}`;
    throw new NeonApiError(`Neon: ${reason}`, res.status);
  }
  return json;
}

/** Uses the pooled host: many short connections from serverless functions. */
export function pooledConnectionString(uri: string, poolerHost: string | undefined): string {
  if (!poolerHost) return uri;
  const url = new URL(uri);
  url.hostname = poolerHost;
  if (!url.searchParams.has("sslmode")) url.searchParams.set("sslmode", "require");
  return url.toString();
}

const DONE = new Set(["finished", "skipped"]);
const FAILED = new Set(["failed", "error", "cancelled"]);

/** Waits until every listed operation has finished; throws if one failed. */
export async function waitForOperations(options: NeonOptions, projectId: string, operationIds: string[]): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  const pending = new Set(operationIds);
  while (pending.size > 0) {
    for (const id of [...pending]) {
      const { operation } = await call<{ operation?: { status?: string } }>(options, "GET", `/projects/${encodeURIComponent(projectId)}/operations/${encodeURIComponent(id)}`);
      const status = operation?.status ?? "";
      if (DONE.has(status)) pending.delete(id);
      else if (FAILED.has(status)) throw new NeonApiError(`Neon: setting up the database ${status}`, 500);
    }
    if (pending.size === 0) break;
    if (Date.now() > deadline) throw new NeonApiError("Neon: the database is still starting. Press Retry in a minute.", 504);
    await new Promise((r) => setTimeout(r, options.pollMs ?? 2000));
  }
}

/**
 * Which organization new projects go in: the configured one, else the
 * account's only organization (personal keys), else none (organization keys,
 * which already belong to one and cannot list a user's organizations).
 */
export async function neonOrgId(options: NeonOptions): Promise<string | undefined> {
  if (options.orgId) return options.orgId;
  try {
    const { organizations } = await call<{ organizations?: { id?: string }[] }>(options, "GET", "/users/me/organizations");
    if (organizations?.length === 1) return organizations[0]!.id;
    if (organizations && organizations.length > 1) {
      throw new NeonApiError("Neon: this account has several organizations. Set NEON_ORG_ID to the one for clinics.", 400);
    }
  } catch (error) {
    if (error instanceof NeonApiError && error.status === 400) throw error;
    // An organization key cannot read this endpoint; it creates in its own organization.
  }
  return undefined;
}

/** Creates a Neon project for one clinic and waits until it accepts connections. */
export async function createNeonProject(options: NeonOptions, input: { name: string; region: string }): Promise<NeonProject> {
  const orgId = await neonOrgId(options);
  const reply = await call<CreateProjectReply>(options, "POST", "/projects", {
    project: { name: input.name, region_id: input.region, pg_version: 17, ...(orgId ? { org_id: orgId } : {}) },
  });
  const projectId = reply.project?.id;
  const conn = reply.connection_uris?.[0];
  if (!projectId || !conn?.connection_uri) throw new NeonApiError("Neon: the reply had no project id or connection string", 502);
  const ops = (reply.operations ?? []).filter((o) => o.id && !DONE.has(o.status ?? "")).map((o) => o.id!);
  await waitForOperations(options, projectId, ops);
  return {
    projectId,
    pooledUrl: pooledConnectionString(conn.connection_uri, conn.connection_parameters?.pooler_host),
    region: reply.project?.region_id ?? input.region,
  };
}
