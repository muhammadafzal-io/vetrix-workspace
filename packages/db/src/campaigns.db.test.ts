// Campaigns on the sample clinic, inside a transaction that is always rolled
// back: audience preview, content versions and the copy check, approval,
// sending in batches with consent and the 7-day limit, unsubscribe, results.
// Skipped without the development database URL (CI).
import { describe, expect, it } from "vitest";
import { Pool } from "@neondatabase/serverless";
import { RuleViolationError, type Audience } from "@vetrix/domain";
import {
  approveCampaign,
  campaignResults,
  cancelCampaign,
  createCampaign,
  getCampaign,
  previewAudience,
  runDueCampaigns,
  saveCampaignAudience,
  saveCampaignContent,
  scheduleCampaign,
  unsubscribeByLink,
  unsubscribeLink,
} from "./campaigns";
import type { SqlClient } from "./sql-client";

const url = process.env.CLINIC_DATABASE_URL_DEV;
const actor = { type: "staff" as const, id: null };
const values = { clinicName: "Main Veterinary Clinic", clinicPhone: "(555) 010-1000", bookingUrl: "https://app.example/w/main", unsubscribeBase: "https://app.example/u/main" };
const dogs: Audience = { match: "all", conditions: [{ type: "species", values: ["dog"] }] };

async function withRollback(fn: (db: SqlClient, loc: string, today: string) => Promise<void>) {
  const pool = new Pool({ connectionString: url, max: 1 });
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const loc = (await db.query<{ id: string }>(`SELECT id FROM locations ORDER BY name LIMIT 1`)).rows[0]!.id;
    // Earlier campaigns in this database (tests or staff) must not count towards
    // the 7-day limit or be sent by these runs.
    await db.query(`DELETE FROM campaign_recipients`);
    await db.query(`UPDATE campaigns SET status = 'cancelled' WHERE status IN ('scheduled', 'sending')`);
    const today = (await db.query<{ d: string }>(`SELECT to_char(now(), 'YYYY-MM-DD') AS d`)).rows[0]!.d;
    await fn(db, loc, today);
  } finally {
    await db.query("ROLLBACK");
    db.release();
    await pool.end();
  }
}

async function readyCampaign(db: SqlClient, loc: string, channels: ("sms" | "email")[] = ["sms", "email"]) {
  const id = await createCampaign(db, { locationId: loc, basics: { name: "Dental month", goal: "February is dental month: 10% off dental cleaning for dogs.", channels }, actor });
  await saveCampaignAudience(db, { locationId: loc, id, audience: dogs, actor });
  if (channels.includes("sms")) await saveCampaignContent(db, { locationId: loc, id, channel: "sms", source: "ai", subject: null, body: "{{clinic_name}}: Hi {{client_first_name}}, 10% off dental cleaning for {{pet_names}}. Book: {{booking_link}}", actor });
  if (channels.includes("email")) await saveCampaignContent(db, { locationId: loc, id, channel: "email", source: "ai", subject: "Dental month at {{clinic_name}}", body: "Hi {{client_first_name}},\n\n10% off dental cleaning for {{pet_names}}. Book: {{booking_link}}", actor });
  return id;
}

describe.skipIf(!url)("campaigns on the clinic database", () => {
  it("keeps AI and staff versions, refuses invented facts, and approves only a clean draft", () =>
    withRollback(async (db, loc) => {
      const id = await readyCampaign(db, loc, ["sms"]);
      const bad = await saveCampaignContent(db, { locationId: loc, id, channel: "sms", source: "staff", subject: null, body: "Hi! 25% off everything, guaranteed!", actor });
      expect(bad.version).toBe(2);
      expect(bad.issues.map((i) => i.kind).sort()).toEqual(["claim", "fact"]);
      await expect(approveCampaign(db, { locationId: loc, id, actor })).rejects.toBeInstanceOf(RuleViolationError);
      await saveCampaignContent(db, { locationId: loc, id, channel: "sms", source: "staff", subject: null, body: "{{clinic_name}}: 10% off dental cleaning for {{pet_names}} this February. {{booking_link}}", actor });
      await approveCampaign(db, { locationId: loc, id, actor });
      const c = await getCampaign(db, loc, id);
      expect(c.status).toBe("approved");
      expect(c.content.map((x) => [x.version, x.source, x.approved])).toEqual([[3, "staff", true], [2, "staff", false], [1, "ai", false]]);
      // Any edit sends it back to draft.
      await saveCampaignContent(db, { locationId: loc, id, channel: "sms", source: "staff", subject: null, body: "{{clinic_name}}: 10% off dental cleaning. {{booking_link}}", actor });
      expect((await getCampaign(db, loc, id)).status).toBe("draft");
    }), 300_000);

  it("previews the audience with consent, then sends once per client and channel, honouring the 7-day limit", () =>
    withRollback(async (db, loc, today) => {
      const id = await readyCampaign(db, loc);
      const now = Date.now();
      const preview = await previewAudience(db, { locationId: loc, audience: dogs, channels: ["sms", "email"], today, now, campaignId: id });
      expect(preview.clients).toBeGreaterThan(0);
      const sms = preview.perChannel.sms!;
      expect(sms.send + Object.values(sms.skipped).reduce((a, b) => a + (b ?? 0), 0)).toBe(preview.clients);

      await expect(scheduleCampaign(db, { locationId: loc, id, sendAt: new Date(now), now, actor })).rejects.toBeInstanceOf(RuleViolationError);
      await approveCampaign(db, { locationId: loc, id, actor });
      await scheduleCampaign(db, { locationId: loc, id, sendAt: new Date(now), now, actor });
      const run = await runDueCampaigns(db, { locationId: loc, now: now + 1000, today, sandbox: true, quietHours: false, values });
      expect(run.finished).toBe(1);
      expect(run.sent).toBe(sms.send + preview.perChannel.email!.send);

      const sent = await db.query<{ channel: string; body: string; subject: string | null }>(
        `SELECT m.channel, m.body, m.subject FROM campaign_recipients r JOIN messages m ON m.id = r.message_id WHERE r.campaign_id = $1`,
        [id],
      );
      const text = sent.rows.find((r) => r.channel === "sms");
      if (text) expect(text.body).toMatch(/^Main Veterinary Clinic: Hi .+, 10% off dental cleaning for .+\. Book: https:\/\/app\.example\/w\/main Reply STOP to opt out\.$/);
      const email = sent.rows.find((r) => r.channel === "email");
      if (email) {
        expect(email.subject).toBe("Dental month at Main Veterinary Clinic");
        expect(email.body).toMatch(/Stop these emails: https:\/\/app\.example\/u\/main\/[A-Za-z0-9_-]{32}$/);
      }
      expect((await getCampaign(db, loc, id)).status).toBe("sent");

      // A second campaign the same week reaches nobody who just got one. (Simulated
      // messages never reached anyone and don't count: pretend these were delivered.)
      await db.query(`UPDATE messages SET status = 'sent' WHERE id IN (SELECT message_id FROM campaign_recipients WHERE campaign_id = $1)`, [id]);
      const second = await readyCampaign(db, loc);
      await approveCampaign(db, { locationId: loc, id: second, actor });
      await scheduleCampaign(db, { locationId: loc, id: second, sendAt: new Date(now), now, actor });
      const again = await runDueCampaigns(db, { locationId: loc, now: now + 2000, today, sandbox: true, quietHours: false, values });
      expect(again.sent).toBe(0);
      const results = await campaignResults(db, loc, second);
      expect(results.skipped.contacted_recently).toBeGreaterThan(0);
    }), 300_000);

  it("fixes the audience when sending starts: later matches are not added, a pet no longer active is left out", () =>
    withRollback(async (db, loc, today) => {
      const id = await readyCampaign(db, loc, ["sms"]);
      await approveCampaign(db, { locationId: loc, id, actor });
      const now = Date.now();
      await scheduleCampaign(db, { locationId: loc, id, sendAt: new Date(now), now, actor });
      // Starts in quiet hours: the audience is fixed, every text waits.
      await runDueCampaigns(db, { locationId: loc, now, today, sandbox: true, quietHours: true, values });
      const fixed = await db.query<{ client_id: string; pet_ids: string[] }>(`SELECT client_id, pet_ids FROM campaign_recipients WHERE campaign_id = $1 AND status = 'pending'`, [id]);
      expect(fixed.rows.length).toBeGreaterThan(0);

      // After the start: a new matching client, and a fixed client's only pet dies.
      const client = (await db.query<{ id: string }>(
        `INSERT INTO clients (location_id, first_name, last_name, mobile, sms_consent, marketing_consent, source) VALUES ($1, 'Late', 'Joiner', '+15550108888', true, true, 'staff') RETURNING id`, [loc],
      )).rows[0]!.id;
      await db.query(`INSERT INTO patients (location_id, client_id, name, species, status) VALUES ($1, $2, 'Newdog', 'dog', 'active')`, [loc, client]);
      const onePet = fixed.rows.find((r) => r.pet_ids.length === 1)!;
      await db.query(`UPDATE patients SET status = 'deceased' WHERE id = $1`, [onePet.pet_ids[0]]);

      await runDueCampaigns(db, { locationId: loc, now, today, sandbox: true, quietHours: false, values });
      const rows = await db.query<{ client_id: string; status: string; skip_reason: string | null }>(`SELECT client_id, status, skip_reason FROM campaign_recipients WHERE campaign_id = $1`, [id]);
      expect(rows.rows).toHaveLength(fixed.rows.length);
      expect(rows.rows.some((r) => r.client_id === client)).toBe(false);
      expect(rows.rows.find((r) => r.client_id === onePet.client_id)).toMatchObject({ status: "skipped", skip_reason: "pet_not_active" });
      expect(rows.rows.every((r) => r.status !== "pending")).toBe(true);
      expect((await getCampaign(db, loc, id)).status).toBe("sent");
    }), 300_000);

  it("does not count simulated messages toward the 7-day limit", () =>
    withRollback(async (db, loc, today) => {
      const now = Date.now();
      const first = await readyCampaign(db, loc, ["email"]);
      await approveCampaign(db, { locationId: loc, id: first, actor });
      await scheduleCampaign(db, { locationId: loc, id: first, sendAt: new Date(now), now, actor });
      const a = await runDueCampaigns(db, { locationId: loc, now, today, sandbox: true, quietHours: false, values });
      const second = await readyCampaign(db, loc, ["email"]);
      await approveCampaign(db, { locationId: loc, id: second, actor });
      await scheduleCampaign(db, { locationId: loc, id: second, sendAt: new Date(now), now, actor });
      const b = await runDueCampaigns(db, { locationId: loc, now, today, sandbox: true, quietHours: false, values });
      expect(b.sent).toBe(a.sent);
    }), 300_000);

  it("Send now sends only its own campaign; the scheduler sends every due one", () =>
    withRollback(async (db, loc, today) => {
      const now = Date.now();
      const a = await readyCampaign(db, loc, ["email"]);
      const b = await readyCampaign(db, loc, ["email"]);
      for (const id of [a, b]) {
        await approveCampaign(db, { locationId: loc, id, actor });
        await scheduleCampaign(db, { locationId: loc, id, sendAt: new Date(now), now, actor });
      }
      const only = await runDueCampaigns(db, { locationId: loc, campaignId: b, now, today, sandbox: true, quietHours: false, values });
      expect(only.campaigns).toBe(1);
      expect((await getCampaign(db, loc, a)).status).toBe("scheduled");
      const rest = await runDueCampaigns(db, { locationId: loc, now, today, sandbox: true, quietHours: false, values });
      expect(rest.campaigns).toBe(1);
      expect((await getCampaign(db, loc, a)).status).toBe("sent");
    }), 300_000);

  it("holds texts in quiet hours, sends in batches, and can be cancelled", () =>
    withRollback(async (db, loc, today) => {
      const id = await readyCampaign(db, loc, ["sms"]);
      await approveCampaign(db, { locationId: loc, id, actor });
      const now = Date.now();
      await scheduleCampaign(db, { locationId: loc, id, sendAt: new Date(now), now, actor });
      const quiet = await runDueCampaigns(db, { locationId: loc, now, today, sandbox: true, quietHours: true, values });
      expect([quiet.sent, quiet.finished]).toEqual([0, 0]);
      expect((await getCampaign(db, loc, id)).status).toBe("sending");
      await cancelCampaign(db, { locationId: loc, id, actor });
      const after = await runDueCampaigns(db, { locationId: loc, now, today, sandbox: true, quietHours: false, values });
      expect(after.campaigns).toBe(0);
    }), 300_000);

  it("unsubscribes by the email link, once, and records the consent change", () =>
    withRollback(async (db, loc, today) => {
      const id = await readyCampaign(db, loc, ["email"]);
      await approveCampaign(db, { locationId: loc, id, actor });
      const now = Date.now();
      await scheduleCampaign(db, { locationId: loc, id, sendAt: new Date(now), now, actor });
      await runDueCampaigns(db, { locationId: loc, now, today, sandbox: true, quietHours: false, values });
      const body = (await db.query<{ body: string; client_id: string }>(`SELECT m.body, m.client_id FROM campaign_recipients r JOIN messages m ON m.id = r.message_id WHERE r.campaign_id = $1 LIMIT 1`, [id])).rows[0];
      if (!body) return; // no dog owner with marketing consent and an email in this database
      const token = body.body.split("/").pop()!;
      expect(await unsubscribeLink(db, token)).toMatchObject({ clinicName: "Main Veterinary Clinic", alreadyOff: false });
      expect(await unsubscribeByLink(db, token)).toBe(true);
      expect(await unsubscribeByLink(db, token)).toBe(true);
      expect(await unsubscribeLink(db, token)).toMatchObject({ alreadyOff: true });
      const consents = await db.query<{ n: number }>(`SELECT count(*)::int n FROM client_consents WHERE client_id = $1 AND source = 'email_unsubscribe'`, [body.client_id]);
      expect(consents.rows[0]!.n).toBe(1);
      expect(await unsubscribeLink(db, "x".repeat(32))).toBeNull();
      expect((await campaignResults(db, loc, id)).unsubscribed).toBe(1);
    }), 300_000);
});
