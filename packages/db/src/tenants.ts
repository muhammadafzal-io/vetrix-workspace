// Registry operations for clinic databases: register one, list them, and
// mirror each database's migration state into tenant_migrations so the
// platform can see every clinic's schema version in one place.
import type { SqlClient } from "./sql-client";

export interface TenantDatabase {
  id: string;
  organization_id: string;
  organization_slug: string;
  database_ref: string;
  region: string;
  schema_version: string | null;
  status: "provisioning" | "active" | "migrating" | "suspended";
}

export async function listTenantDatabases(registry: SqlClient): Promise<TenantDatabase[]> {
  const { rows } = await registry.query<TenantDatabase>(
    `SELECT td.id, td.organization_id, o.slug AS organization_slug, td.database_ref,
            td.region, td.schema_version, td.status
     FROM tenant_databases td JOIN organizations o ON o.id = td.organization_id
     ORDER BY o.slug`,
  );
  return rows;
}

export interface RegisterTenantInput {
  name: string;
  slug: string;
  databaseRef: string;
  region: string;
}

/** Creates the organization and its tenant_databases row. Safe to re-run. */
export async function registerTenant(registry: SqlClient, input: RegisterTenantInput): Promise<TenantDatabase> {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(input.slug)) {
    throw new Error(`slug "${input.slug}" must be lowercase words joined by hyphens`);
  }
  await registry.query("BEGIN");
  try {
    const org = await registry.query<{ id: string }>(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [input.name, input.slug],
    );
    const orgId = org.rows[0]!.id;
    await registry.query(
      `INSERT INTO tenant_databases (organization_id, database_ref, region)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id) DO UPDATE
         SET database_ref = EXCLUDED.database_ref, region = EXCLUDED.region`,
      [orgId, input.databaseRef, input.region],
    );
    await registry.query("COMMIT");
  } catch (error) {
    await registry.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  const tenant = (await listTenantDatabases(registry)).find((t) => t.organization_slug === input.slug);
  if (!tenant) throw new Error(`tenant ${input.slug} was not saved`);
  return tenant;
}

export async function setTenantStatus(
  registry: SqlClient,
  tenantDatabaseId: string,
  status: TenantDatabase["status"],
): Promise<void> {
  await registry.query(`UPDATE tenant_databases SET status = $2 WHERE id = $1`, [tenantDatabaseId, status]);
}

/** Records the outcome of migrating one clinic database. */
export async function recordTenantMigrations(
  registry: SqlClient,
  tenantDatabaseId: string,
  outcome: { applied: string[]; schemaVersion: string | null } | { failedVersion: string },
): Promise<void> {
  if ("failedVersion" in outcome) {
    await registry.query(
      `INSERT INTO tenant_migrations (tenant_database_id, version, status) VALUES ($1, $2, 'failed')
       ON CONFLICT (tenant_database_id, version) DO UPDATE SET status = 'failed', applied_at = NULL`,
      [tenantDatabaseId, outcome.failedVersion],
    );
    return;
  }
  for (const version of outcome.applied) {
    await registry.query(
      `INSERT INTO tenant_migrations (tenant_database_id, version, status, applied_at)
       VALUES ($1, $2, 'applied', now())
       ON CONFLICT (tenant_database_id, version) DO UPDATE SET status = 'applied', applied_at = now()`,
      [tenantDatabaseId, version],
    );
  }
  await registry.query(
    `UPDATE tenant_databases SET schema_version = $2, status = 'active' WHERE id = $1`,
    [tenantDatabaseId, outcome.schemaVersion],
  );
}

export interface PlatformOverview {
  clinics: number;
  active: number;
  settingUp: number;
  suspended: number;
  /** Setups that stopped with an error, or active clinics whose invite failed. */
  needsAttention: number;
  people: number;
  admins: number;
  addedLast30Days: number;
}

/** Numbers for the admin dashboard. Read-only; safe on a pool. */
export async function platformOverview(registry: SqlClient): Promise<PlatformOverview> {
  const { rows } = await registry.query<Record<keyof PlatformOverview, number>>(
    `SELECT
       (SELECT count(*) FROM tenant_databases)::int AS clinics,
       (SELECT count(*) FROM tenant_databases WHERE status = 'active')::int AS active,
       (SELECT count(*) FROM tenant_databases WHERE status IN ('provisioning', 'migrating'))::int AS "settingUp",
       (SELECT count(*) FROM tenant_databases WHERE status = 'suspended')::int AS suspended,
       (SELECT count(*) FROM tenant_databases WHERE last_error IS NOT NULL)::int AS "needsAttention",
       (SELECT count(*) FROM platform_users WHERE status = 'active')::int AS people,
       (SELECT count(*) FROM platform_users WHERE is_platform_admin AND status = 'active')::int AS admins,
       (SELECT count(*) FROM tenant_databases WHERE created_at > now() - interval '30 days')::int AS "addedLast30Days"`,
  );
  return rows[0]!;
}
