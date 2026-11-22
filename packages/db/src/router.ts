// Tenant routing: given an organization, return a connection pool for its own
// clinic database. Lookups are cached briefly so each request does not hit the
// registry; pools are cached per database so connections are reused.
import { Pool } from "@neondatabase/serverless";
import { flowOn, trace } from "@vetrix/domain";
import { resolveDatabaseRef } from "./database-ref";
import type { TenantDatabase } from "./tenants";

export class TenantNotFoundError extends Error {
  constructor(readonly organization: string) {
    super(`No clinic database is registered for organization "${organization}"`);
    this.name = "TenantNotFoundError";
  }
}

export class TenantUnavailableError extends Error {
  constructor(
    readonly organization: string,
    readonly status: TenantDatabase["status"],
  ) {
    super(`Clinic database for "${organization}" is ${status}`);
    this.name = "TenantUnavailableError";
  }
}

/** The pieces of a pg-style pool the router needs; real Pool or a test fake. */
export interface PoolLike {
  end(): Promise<void>;
}

export interface TenantRouterOptions<P extends PoolLike> {
  /** Finds the tenant row by organization slug or id. */
  lookup: (organization: string) => Promise<TenantDatabase | undefined>;
  createPool: (connectionString: string) => P;
  env?: Record<string, string | undefined>;
  /** How long a registry lookup is reused. Default 60 seconds. */
  ttlMs?: number;
  now?: () => number;
}

export interface TenantRouter<P extends PoolLike> {
  clinicPool(organization: string): Promise<{ tenant: TenantDatabase; pool: P }>;
  /** Forget a cached lookup, e.g. after a tenant is suspended or moved. */
  invalidate(organization: string): void;
  close(): Promise<void>;
}

export function createTenantRouter<P extends PoolLike>(options: TenantRouterOptions<P>): TenantRouter<P> {
  const ttlMs = options.ttlMs ?? 60_000;
  const now = options.now ?? Date.now;
  const lookups = new Map<string, { tenant: TenantDatabase; expiresAt: number }>();
  const pools = new Map<string, P>();

  return {
    async clinicPool(organization) {
      let entry = lookups.get(organization);
      const fresh = entry && entry.expiresAt > now();
      trace("tenancy", "db/router.ts › clinicPool", fresh ? `${organization}: database known (cached 60 s)` : `${organization}: look up its database in the registry`);
      if (!entry || entry.expiresAt <= now()) {
        const tenant = await options.lookup(organization);
        if (!tenant) {
          lookups.delete(organization);
          throw new TenantNotFoundError(organization);
        }
        entry = { tenant, expiresAt: now() + ttlMs };
        lookups.set(organization, entry);
      }
      const { tenant } = entry;
      if (tenant.status !== "active") throw new TenantUnavailableError(organization, tenant.status);

      const url = resolveDatabaseRef(tenant.database_ref, options.env);
      let pool = pools.get(url);
      if (!pool) {
        trace("tenancy", "db/router.ts › clinicPool", "open a new connection pool for this clinic database (once per server)");
        pool = options.createPool(url);
        pools.set(url, pool);
      }
      return { tenant, pool };
    },
    invalidate(organization) {
      lookups.delete(organization);
    },
    async close() {
      const all = [...pools.values()];
      pools.clear();
      lookups.clear();
      await Promise.all(all.map((p) => p.end()));
    },
  };
}

const TENANT_LOOKUP_SQL = `
  SELECT td.id, td.organization_id, o.slug AS organization_slug, td.database_ref,
         td.region, td.schema_version, td.status
  FROM tenant_databases td JOIN organizations o ON o.id = td.organization_id
  WHERE o.status = 'active' AND (o.slug = $1 OR o.id::text = $1)`;

/**
 * Measuring only (DB_QUERY_LOG=1 or FLOW_TRACE=1, off by default): prints each
 * query's duration and the start of its SQL, including queries inside
 * transactions. Parameters are never printed, so no client details reach the logs.
 */
type Queryable = { query: (...args: unknown[]) => Promise<unknown> };

function wrapQuery(target: Queryable, label: string): void {
  const query = target.query.bind(target);
  target.query = (...args) => {
    // pg calls itself with a callback (pool.query → client.query): leave those alone.
    if (typeof args[args.length - 1] === "function") return query(...args);
    const started = performance.now();
    const text = typeof args[0] === "string" ? args[0] : String((args[0] as { text?: string })?.text ?? "");
    const sql = text.replace(/\s+/g, " ").trim().slice(0, 90);
    return query(...args).finally(() => {
      const ms = Math.round(performance.now() - started);
      if (flowOn()) trace("db", label, `${ms} ms  ${sql}`);
      else console.info(`[db:${label}] ${ms}ms ${sql}`);
    });
  };
}

function logQueries(pool: Pool, name: string): void {
  wrapQuery(pool as unknown as Queryable, `${name} database`);
  // Transactions borrow one connection from the pool; wrap it once.
  // The callback form is pg's own pool.query (already logged above): untouched.
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => Promise<Queryable & { vetrixTraced?: boolean }> | void;
  (pool as unknown as { connect: typeof connect }).connect = (...args: unknown[]) => {
    if (args.length > 0) return connect(...args);
    return (connect() as Promise<Queryable & { vetrixTraced?: boolean }>).then((client) => {
      if (!client.vetrixTraced) {
        wrapQuery(client, `${name} database (transaction)`);
        client.vetrixTraced = true;
      }
      return client;
    });
  };
}

/** Production router: registry over Neon, one small pool per clinic database. */
export function createNeonTenantRouter(registryUrl: string, env: Record<string, string | undefined> = process.env) {
  // An idle connection the database drops (restart, password change, network)
  // emits "error" on the pool; without a listener Node treats it as a crash.
  // Log it and let the next query open a fresh connection.
  const quiet = (pool: Pool, name: string) => {
    pool.on("error", (error: Error) => console.warn(`[db] ${name} connection dropped: ${error.message}`));
    if (env.DB_QUERY_LOG === "1" || env.FLOW_TRACE === "1") logQueries(pool, name);
    return pool;
  };
  const registry = quiet(new Pool({ connectionString: registryUrl, max: 5 }), "registry");
  const router = createTenantRouter<Pool>({
    env,
    lookup: async (organization) => {
      const { rows } = await registry.query<TenantDatabase>(TENANT_LOOKUP_SQL, [organization]);
      return rows[0];
    },
    createPool: (connectionString) => quiet(new Pool({ connectionString, max: 5 }), "clinic"),
  });
  return {
    registry,
    ...router,
    async close() {
      await router.close();
      await registry.end();
    },
  };
}
