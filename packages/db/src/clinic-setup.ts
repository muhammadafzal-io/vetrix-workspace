// Adds a clinic to the platform: its own Neon database, its tables, a first
// location with the pack defaults, and its owner. Used by the platform admin's
// Clinics page (apps/web) through "@vetrix/db/clinic-setup".
//
// Every step can run again safely, so a failed setup is finished by Retry:
//   1 database  create the Neon project; save its connection string encrypted
//   2 schema    run the clinic migrations (63 tables)
//   3 clinic    first location (status "onboarding") + pack defaults
//   4 owner     registry person + membership, and their owner staff record
//   5 activate  tenant_databases.status = 'active' (the router now opens it)
//   6 invite    email the owner a link to set a password
// The clinic only opens (step 5) once steps 1–4 are done. No sample data is
// ever loaded here.
//
// `registry` must be ONE dedicated connection (pool.connect()), never a pool:
// these functions use BEGIN/COMMIT, which a pool may send to different connections.
import { Pool } from "@neondatabase/serverless";
import { ConflictError, DEFAULT_CLINIC_REGION, ONBOARDING_STEPS, type ValidNewClinic } from "@vetrix/domain";
import { getVeterinaryPack, veterinaryRawPack } from "@vetrix/pack";
import { syncRoleCatalogue, upsertStaffMember } from "./access";
import { encryptDatabaseUrl, neonRegionFromUrl, resolveDatabaseRef } from "./database-ref";
import { addOrganizationMember, ensurePlatformUser } from "./members";
import { loadMigrations, migrateDatabase } from "./migrations";
import { createNeonProject, type NeonOptions } from "./neon";
import { installPackDefaults } from "./pack-defaults";
import { publishPack } from "./packs";
import type { SqlClient } from "./sql-client";
import { recordTenantMigrations } from "./tenants";

export interface ClinicSummary {
  tenantId: string;
  organizationId: string;
  name: string;
  slug: string;
  status: "provisioning" | "active" | "migrating" | "suspended";
  region: string;
  schemaVersion: string | null;
  neonProjectId: string | null;
  ownerEmail: string | null;
  lastError: string | null;
  running: boolean;
  createdAt: Date;
}

/** Every clinic database, newest first, for the platform admin. */
export async function listClinics(registry: SqlClient): Promise<ClinicSummary[]> {
  const { rows } = await registry.query<{
    tenant_id: string; organization_id: string; name: string; slug: string; status: ClinicSummary["status"]; region: string;
    schema_version: string | null; neon_project_id: string | null; owner_email: string | null; last_error: string | null;
    running: boolean; created_at: Date;
  }>(
    `SELECT td.id AS tenant_id, o.id AS organization_id, o.name, o.slug, td.status, td.region, td.schema_version,
            td.neon_project_id, td.setup_request->>'ownerEmail' AS owner_email, td.last_error,
            (td.setup_started_at IS NOT NULL AND td.setup_started_at > now() - interval '5 minutes') AS running,
            td.created_at
     FROM tenant_databases td JOIN organizations o ON o.id = td.organization_id
     ORDER BY td.created_at DESC, o.name`,
  );
  return rows.map((r) => ({
    tenantId: r.tenant_id,
    organizationId: r.organization_id,
    name: r.name,
    slug: r.slug,
    status: r.status,
    region: r.region,
    schemaVersion: r.schema_version,
    neonProjectId: r.neon_project_id,
    ownerEmail: r.owner_email,
    lastError: r.last_error,
    running: r.running,
    createdAt: r.created_at,
  }));
}

/** Not a real reference: the database does not exist yet (step 1 replaces it). */
const PENDING_REF = "pending:";

/** Saves the request and reserves the slug. The clinic stays closed until setup finishes. */
export async function startClinicSetup(registry: SqlClient, input: ValidNewClinic): Promise<string> {
  const taken = await registry.query(`SELECT 1 FROM organizations WHERE slug = $1`, [input.slug]);
  if (taken.rows.length > 0) throw new ConflictError(`The address "${input.slug}" is already used by another clinic.`);
  await registry.query("BEGIN");
  try {
    const org = await registry.query<{ id: string }>(`INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`, [input.clinicName, input.slug]);
    const request = { locationName: input.locationName, timezone: input.timezone, ownerName: input.ownerName, ownerEmail: input.ownerEmail };
    const td = await registry.query<{ id: string }>(
      `INSERT INTO tenant_databases (organization_id, database_ref, region, status, setup_request)
       VALUES ($1, $2, $3, 'provisioning', $4) RETURNING id`,
      [org.rows[0]!.id, PENDING_REF, DEFAULT_CLINIC_REGION, JSON.stringify(request)],
    );
    await registry.query("COMMIT");
    return td.rows[0]!.id;
  } catch (error) {
    await registry.query("ROLLBACK").catch(() => undefined);
    if ((error as { code?: string }).code === "23505") throw new ConflictError(`The address "${input.slug}" is already used by another clinic.`);
    throw error;
  }
}

export interface ClinicSetupDeps {
  neon: NeonOptions;
  /** DATABASE_SECRETS_KEY: encrypts the new database's connection string. */
  secretsKey: string;
  /** Emails the owner a "set your password" link. */
  sendInvite: (email: string) => Promise<void>;
  /** Progress, for logs: step id only, never secrets. */
  onStep?: (step: string) => void;
  /** Opens one dedicated connection (tests pass their own). */
  connect?: (url: string) => Promise<{ client: SqlClient; close: () => Promise<void> }>;
  env?: Record<string, string | undefined>;
}

async function defaultConnect(url: string) {
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  return {
    client,
    close: async () => {
      client.release();
      await pool.end();
    },
  };
}

interface TenantRow {
  id: string;
  organization_id: string;
  slug: string;
  status: ClinicSummary["status"];
  database_ref: string;
  neon_project_id: string | null;
  setup_request: { locationName: string; timezone: string; ownerName: string; ownerEmail: string } | null;
}

/**
 * Runs (or finishes) the setup of one clinic. Throws with a message that is
 * also saved in last_error, so the Clinics page can show it and offer Retry.
 */
export async function runClinicSetup(registry: SqlClient, tenantId: string, deps: ClinicSetupDeps): Promise<void> {
  // Claim the setup: only one run at a time (a run that stopped 5 minutes ago counts as abandoned).
  const claim = await registry.query(
    `UPDATE tenant_databases SET setup_started_at = now()
     WHERE id = $1 AND (setup_started_at IS NULL OR setup_started_at < now() - interval '5 minutes') RETURNING id`,
    [tenantId],
  );
  if (claim.rows.length === 0) throw new ConflictError("This clinic is already being set up. Wait a moment, then refresh.");
  try {
    await setupSteps(registry, tenantId, deps);
    await registry.query(`UPDATE tenant_databases SET last_error = NULL, setup_started_at = NULL WHERE id = $1`, [tenantId]);
  } catch (error) {
    const message = (error as { userMessage?: string }).userMessage ?? (error as Error).message ?? "Setup failed";
    await registry
      .query(`UPDATE tenant_databases SET last_error = $2, setup_started_at = NULL WHERE id = $1`, [tenantId, message.slice(0, 500)])
      .catch(() => undefined);
    throw error;
  }
}

async function loadTenant(registry: SqlClient, tenantId: string): Promise<TenantRow> {
  const { rows } = await registry.query<TenantRow>(
    `SELECT td.id, td.organization_id, o.slug, td.status, td.database_ref, td.neon_project_id, td.setup_request
     FROM tenant_databases td JOIN organizations o ON o.id = td.organization_id WHERE td.id = $1`,
    [tenantId],
  );
  if (!rows[0]) throw new Error("Clinic not found");
  return rows[0];
}

async function setupSteps(registry: SqlClient, tenantId: string, deps: ClinicSetupDeps): Promise<void> {
  const step = deps.onStep ?? (() => undefined);
  let t = await loadTenant(registry, tenantId);
  const req = t.setup_request;
  if (!req) throw new Error("This clinic was not added from the Clinics page, so it cannot be set up here. Use the command line.");

  // 1 database
  if (t.database_ref === PENDING_REF) {
    step("database");
    if (t.neon_project_id) {
      throw new Error(`A Neon project (${t.neon_project_id}) exists but its connection string was not saved. Check it in the Neon console.`);
    }
    const project = await createNeonProject(deps.neon, { name: `vetrix-${t.slug}`, region: DEFAULT_CLINIC_REGION });
    await registry.query(`UPDATE tenant_databases SET neon_project_id = $2, database_ref = $3, region = $4 WHERE id = $1`, [
      tenantId,
      project.projectId,
      encryptDatabaseUrl(project.pooledUrl, deps.secretsKey),
      neonRegionFromUrl(project.pooledUrl) === "unknown" ? project.region : neonRegionFromUrl(project.pooledUrl),
    ]);
    t = await loadTenant(registry, tenantId);
  }

  const url = resolveDatabaseRef(t.database_ref, { ...(deps.env ?? process.env), DATABASE_SECRETS_KEY: deps.secretsKey });
  const { client, close } = await (deps.connect ?? defaultConnect)(url);
  let applied: string[] = [];
  try {
    // 2 schema
    step("schema");
    const files = loadMigrations("clinic");
    applied = (await migrateDatabase(client, "clinic", files)).applied;
    const schemaVersion = files.at(-1)?.version ?? null;

    // 3 clinic: first location + pack defaults, once.
    step("clinic");
    const pack = getVeterinaryPack();
    const configPackId = (await publishPack(registry, veterinaryRawPack)).configPackId;
    await client.query("BEGIN");
    try {
      await syncRoleCatalogue(client);
      const existing = await client.query<{ id: string }>(`SELECT id FROM locations LIMIT 1`);
      if (existing.rows.length === 0) {
        const loc = await client.query<{ id: string }>(
          `INSERT INTO locations (vertical_id, vertical_locked, name, timezone, status) VALUES ($1, true, $2, $3, 'onboarding') RETURNING id`,
          [pack.manifest.vertical_id, req.locationName, req.timezone],
        );
        const locationId = loc.rows[0]!.id;
        // Dogs and cats until the owner chooses in onboarding step 1.
        for (const s of ["dog", "cat"]) await client.query(`INSERT INTO location_species VALUES ($1, $2)`, [locationId, s]);
        await client.query(`INSERT INTO location_after_hours (location_id) VALUES ($1)`, [locationId]);
        await client.query(`INSERT INTO location_policies (location_id) VALUES ($1)`, [locationId]);
        await client.query(`INSERT INTO location_phone_settings (location_id, greeting_text, ai_persona_name) VALUES ($1, $2, $3)`, [
          locationId,
          `Thanks for calling ${req.locationName}.`,
          pack.brand.ai_persona.default_name,
        ]);
        await client.query(`INSERT INTO location_messaging_settings (location_id, sms_sender_name, quiet_start, quiet_end) VALUES ($1, $2, $3, $4)`, [
          locationId,
          req.locationName.slice(0, 30),
          pack.retention.engine.quiet_hours_local.start,
          pack.retention.engine.quiet_hours_local.end,
        ]);
        await client.query(`INSERT INTO location_pack_configs (location_id, config_pack_ref, pack_version) VALUES ($1, $2, $3)`, [
          locationId,
          configPackId,
          pack.manifest.pack_version,
        ]);
        await installPackDefaults(client, pack, locationId);
        for (const o of ONBOARDING_STEPS) {
          await client.query(`INSERT INTO onboarding_steps (location_id, step_number, mandatory) VALUES ($1, $2, $3)`, [locationId, o.step, o.mandatory]);
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }

    // 4 owner: staff record first, membership last (the person can only open
    // the clinic once their staff record exists).
    step("owner");
    const user = await ensurePlatformUser(registry, req.ownerEmail, req.ownerName);
    await client.query("BEGIN");
    try {
      await upsertStaffMember(client, { platformUserId: user.id, displayName: req.ownerName, role: "owner" });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    await addOrganizationMember(registry, t.organization_id, user.id);

    // 5 activate: records the schema version and opens the clinic to the router.
    step("activate");
    await recordTenantMigrations(registry, tenantId, { applied, schemaVersion });
  } finally {
    await close();
  }

  // 6 invite
  step("invite");
  try {
    await deps.sendInvite(req.ownerEmail);
  } catch {
    throw new Error("The clinic is ready, but the invite email could not be sent. Use Resend invite.");
  }
}

/** Emails the owner the "set your password" link again. */
export async function resendClinicInvite(registry: SqlClient, tenantId: string, sendInvite: (email: string) => Promise<void>): Promise<void> {
  const t = await loadTenant(registry, tenantId);
  if (t.status !== "active") throw new ConflictError("Finish the setup first.");
  if (!t.setup_request) throw new ConflictError("This clinic was added from the command line; add staff with pnpm db:staff:add.");
  await sendInvite(t.setup_request.ownerEmail);
  await registry.query(`UPDATE tenant_databases SET last_error = NULL WHERE id = $1`, [tenantId]);
}
