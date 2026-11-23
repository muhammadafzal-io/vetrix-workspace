"use server";

// Clinics page (platform admins only): add a clinic, retry a setup that
// stopped, and resend the owner's invite. The steps themselves live in
// packages/db/src/clinic-setup.ts; this file checks who is asking, reads the
// form and supplies the Neon key, the secrets key and the invite email.
import { revalidatePath } from "next/cache";
import { ValidationError, validateNewClinic } from "@vetrix/domain";
import { resendClinicInvite, runClinicSetup, startClinicSetup, type ClinicSetupDeps } from "@vetrix/db/clinic-setup";
import type { SqlClient } from "@vetrix/db/runtime";
import { formValues, toActionError, type ActionResult } from "@/lib/action-result";
import { auth } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { requirePlatformAdmin } from "@/lib/session";
import { tenancy } from "@/lib/tenancy";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The same "set your password" email as Forgot password, used as the owner's invite. */
async function sendInvite(email: string): Promise<void> {
  await auth().api.requestPasswordReset({ body: { email, redirectTo: `${getEnv().APP_URL}/reset-password` } });
}

function setupDeps(): ClinicSetupDeps {
  const env = getEnv();
  if (!env.NEON_API_KEY || !env.DATABASE_SECRETS_KEY) {
    throw new ValidationError("Set NEON_API_KEY and DATABASE_SECRETS_KEY on the server before adding clinics.");
  }
  const log = logger.child({ component: "clinic-setup" });
  return {
    neon: { apiKey: env.NEON_API_KEY, orgId: env.NEON_ORG_ID },
    secretsKey: env.DATABASE_SECRETS_KEY,
    sendInvite,
    onStep: (step) => log.info("clinic setup step", { step }),
  };
}

/**
 * Setup uses BEGIN/COMMIT on the registry, so it needs one dedicated
 * connection from the pool, not the pool itself.
 */
async function withRegistryConnection<T>(fn: (registry: SqlClient) => Promise<T>): Promise<T> {
  const client = await tenancy().registry.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function addClinicAction(_: ActionResult | null, form: FormData): Promise<ActionResult> {
  const values = formValues(form);
  const text = (k: string) => String(form.get(k) ?? "");
  let tenantId: string | null = null;
  try {
    const admin = await requirePlatformAdmin();
    const input = validateNewClinic({
      clinicName: text("clinicName"),
      slug: text("slug"),
      locationName: text("locationName"),
      timezone: text("timezone"),
      ownerName: text("ownerName"),
      ownerEmail: text("ownerEmail"),
    });
    const deps = setupDeps();
    await withRegistryConnection(async (registry) => {
      tenantId = await startClinicSetup(registry, input);
      logger.info("clinic setup started", { tenantId, slug: input.slug, by: admin.platformUserId });
      await runClinicSetup(registry, tenantId, deps);
    });
    revalidatePath("/admin", "layout");
    return { ok: true, message: `${input.clinicName} is ready. ${input.ownerEmail} was emailed a link to set a password.` };
  } catch (error) {
    revalidatePath("/admin", "layout");
    // The clinic row exists once setup started: the list shows the error and a Retry button.
    const result = tenantId ? setupFailed(error) : toActionError(error);
    return result.ok ? result : { ...result, values };
  }
}

/** Setup errors carry a plain message (Neon, migrations); show it, it never contains a secret. */
function setupFailed(error: unknown): ActionResult {
  const r = toActionError(error);
  if (r.ok || (error as { userMessage?: string }).userMessage) return r;
  const message = error instanceof Error ? error.message.slice(0, 300) : "Setup failed.";
  return { ok: false, error: `Setup stopped: ${message} The clinic is listed below; press Retry.` };
}

export async function retryClinicAction(tenantId: string): Promise<ActionResult> {
  try {
    await requirePlatformAdmin();
    if (!UUID.test(tenantId)) throw new ValidationError("Unknown clinic.");
    const deps = setupDeps();
    await withRegistryConnection((registry) => runClinicSetup(registry, tenantId, deps));
    revalidatePath("/admin", "layout");
    return { ok: true, message: "Setup finished." };
  } catch (error) {
    revalidatePath("/admin", "layout");
    return setupFailed(error);
  }
}

export async function resendInviteAction(tenantId: string): Promise<ActionResult> {
  try {
    await requirePlatformAdmin();
    if (!UUID.test(tenantId)) throw new ValidationError("Unknown clinic.");
    await withRegistryConnection((registry) => resendClinicInvite(registry, tenantId, sendInvite));
    revalidatePath("/admin", "layout");
    return { ok: true, message: "Invite sent." };
  } catch (error) {
    return toActionError(error);
  }
}
