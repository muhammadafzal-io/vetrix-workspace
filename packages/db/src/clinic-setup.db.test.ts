// Adding a clinic end to end, against the dev Neon server. Neon's API is
// faked: "creating a project" hands back a scratch database
// (vetrix_setup_test) made for this test. Everything the test creates, in the
// registry and the scratch database, is deleted afterwards.
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "@neondatabase/serverless";
import { validateNewClinic } from "@vetrix/domain";
import { listClinics, resendClinicInvite, runClinicSetup, startClinicSetup } from "./clinic-setup";
import { decryptDatabaseUrl } from "./database-ref";
import { publicTables } from "./migrations";
import type { SqlClient } from "./sql-client";

const registryUrl = process.env.REGISTRY_DATABASE_URL;
const clinicUrl = process.env.CLINIC_DATABASE_URL_DEV;
const SCRATCH_DB = "vetrix_setup_test";
const SLUG = "setup-test-clinic";
const OWNER = "owner.setup-test@example.com";
const key = Buffer.alloc(32, 3).toString("base64");

function scratchUrl(): string {
  const u = new URL(clinicUrl!);
  u.pathname = `/${SCRATCH_DB}`;
  return u.toString();
}

/** Neon API stand-in: one project whose database is the scratch database. */
function fakeNeon(calls: string[]) {
  return (async (url: string, init: RequestInit) => {
    calls.push(`${init.method ?? "GET"} ${new URL(url).pathname}`);
    return new Response(
      JSON.stringify({ project: { id: "proj-test", region_id: "aws-us-east-1" }, connection_uris: [{ connection_uri: scratchUrl() }], operations: [] }),
      { status: 201 },
    );
  }) as unknown as typeof fetch;
}

async function withClient<T>(url: string, fn: (c: SqlClient) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
    await pool.end();
  }
}

async function cleanRegistry(registry: SqlClient) {
  await registry.query(`DELETE FROM organization_members WHERE organization_id IN (SELECT id FROM organizations WHERE slug = $1)`, [SLUG]);
  await registry.query(`DELETE FROM tenant_databases WHERE organization_id IN (SELECT id FROM organizations WHERE slug = $1)`, [SLUG]);
  await registry.query(`DELETE FROM organizations WHERE slug = $1`, [SLUG]);
  await registry.query(`DELETE FROM platform_users WHERE email = $1`, [OWNER]);
}

describe.skipIf(!registryUrl || !clinicUrl)("adding a clinic", () => {
  afterAll(async () => {
    if (!registryUrl || !clinicUrl) return;
    await withClient(registryUrl, cleanRegistry);
    await withClient(clinicUrl, (c) => c.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  });

  it("creates the database, tables, first location and owner; retries safely; never loads sample data", { timeout: 180_000 }, async () => {
    await withClient(clinicUrl!, async (c) => {
      await c.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      await c.query(`CREATE DATABASE ${SCRATCH_DB}`);
    });

    await withClient(registryUrl!, async (registry) => {
      await cleanRegistry(registry);
      const input = validateNewClinic({ clinicName: "Setup Test Clinic", slug: SLUG, locationName: "Main", timezone: "America/Chicago", ownerName: "Olive Owner", ownerEmail: OWNER });
      const tenantId = await startClinicSetup(registry, input);
      await expect(startClinicSetup(registry, input)).rejects.toThrow(/already used/);

      const neonCalls: string[] = [];
      const invites: string[] = [];
      let failConnect = true;
      const deps = {
        neon: { apiKey: "test", fetchImpl: fakeNeon(neonCalls), pollMs: 0 },
        secretsKey: key,
        sendInvite: async (email: string) => {
          invites.push(email);
        },
        // First run: the new database "cannot be reached" after it was created.
        connect: async (url: string) => {
          if (failConnect) throw new Error("connection refused");
          const pool = new Pool({ connectionString: url, max: 1 });
          const client = await pool.connect();
          return { client, close: async () => (client.release(), await pool.end()) };
        },
      };

      // Run 1 stops after creating the database: still closed, error saved, no invite.
      await expect(runClinicSetup(registry, tenantId, deps)).rejects.toThrow(/connection refused/);
      let row = (await listClinics(registry)).find((c) => c.slug === SLUG)!;
      expect(row).toMatchObject({ status: "provisioning", neonProjectId: "proj-test", lastError: "connection refused", running: false });
      expect(invites).toEqual([]);
      const ref = (await registry.query<{ database_ref: string }>(`SELECT database_ref FROM tenant_databases WHERE id = $1`, [tenantId])).rows[0]!.database_ref;
      expect(ref.startsWith("enc:v1:")).toBe(true);
      expect(ref).not.toContain(SCRATCH_DB);
      expect(decryptDatabaseUrl(ref, key)).toBe(scratchUrl());

      // A run already in progress blocks a second one.
      await registry.query(`UPDATE tenant_databases SET setup_started_at = now() WHERE id = $1`, [tenantId]);
      await expect(runClinicSetup(registry, tenantId, deps)).rejects.toThrow(/already being set up/);
      await registry.query(`UPDATE tenant_databases SET setup_started_at = NULL WHERE id = $1`, [tenantId]);

      // Retry: picks up where it stopped. Neon is not asked for a second project.
      failConnect = false;
      await runClinicSetup(registry, tenantId, deps);
      expect(neonCalls).toEqual(["POST /api/v2/projects"]);
      row = (await listClinics(registry)).find((c) => c.slug === SLUG)!;
      expect(row).toMatchObject({ status: "active", lastError: null, ownerEmail: OWNER });
      expect(row.schemaVersion).toMatch(/^\d{3}_/);
      expect(invites).toEqual([OWNER]);

      // Owner can open the organization.
      const member = await registry.query(
        `SELECT 1 FROM organization_members m JOIN platform_users u ON u.id = m.platform_user_id JOIN organizations o ON o.id = m.organization_id
         WHERE u.email = $1 AND o.slug = $2 AND m.status = 'active'`,
        [OWNER, SLUG],
      );
      expect(member.rows).toHaveLength(1);

      // Running again (e.g. a double Retry) changes nothing.
      await runClinicSetup(registry, tenantId, deps);

      await withClient(scratchUrl(), async (clinic) => {
        expect((await publicTables(clinic)).length).toBe(67);
        const n = async (sql: string) => Number((await clinic.query<{ n: string }>(sql)).rows[0]!.n);
        expect(await n(`SELECT count(*) AS n FROM locations WHERE status = 'onboarding' AND vertical_locked`)).toBe(1);
        expect(await n(`SELECT count(*) AS n FROM services`)).toBeGreaterThan(10);
        expect(await n(`SELECT count(*) AS n FROM reminder_rules`)).toBeGreaterThan(0);
        expect(await n(`SELECT count(*) AS n FROM onboarding_steps`)).toBe(10);
        expect(await n(`SELECT count(*) AS n FROM onboarding_steps WHERE mandatory`)).toBe(4);
        expect(await n(`SELECT count(*) AS n FROM staff_users su JOIN staff_location_roles slr ON slr.staff_user_id = su.id JOIN roles r ON r.id = slr.role_id WHERE r.name = 'owner'`)).toBe(1);
        // No sample data, ever.
        expect(await n(`SELECT count(*) AS n FROM clients`)).toBe(0);
        expect(await n(`SELECT count(*) AS n FROM patients`)).toBe(0);
        expect(await n(`SELECT count(*) AS n FROM providers`)).toBe(0);
      });

      // Invite email failure: the clinic is open, the error says to resend.
      const failing = { ...deps, sendInvite: async () => Promise.reject(new Error("smtp down")) };
      await expect(runClinicSetup(registry, tenantId, failing)).rejects.toThrow(/Resend invite/);
      expect((await listClinics(registry)).find((c) => c.slug === SLUG)!).toMatchObject({ status: "active", lastError: expect.stringMatching(/Resend invite/) });
      await resendClinicInvite(registry, tenantId, deps.sendInvite);
      expect((await listClinics(registry)).find((c) => c.slug === SLUG)!.lastError).toBeNull();
      expect(invites).toEqual([OWNER, OWNER, OWNER]);
    });
  });
});
