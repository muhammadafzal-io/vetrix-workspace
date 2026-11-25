// Marketing campaigns against a clinic database: create and edit a campaign,
// preview its audience, keep every version of its text and email (AI drafts
// and staff edits apart), approve, schedule, send in batches from the
// scheduler, unsubscribe by email link, and the results.
//
// Rules (audience, consent, 7-day limit, copy check) live in @vetrix/domain.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  CAMPAIGN_BATCH_SIZE,
  campaignEligibility,
  canChangeCampaign,
  checkCampaignCopy,
  ConflictError,
  fillCampaignMessage,
  limitToChosen,
  joinPetNames,
  NotFoundError,
  RuleViolationError,
  selectAudience,
  ValidationError,
  type Audience,
  type AudiencePet,
  type CampaignChannel,
  type CampaignClient,
  type CampaignStatus,
  type CopyIssue,
  type SkipReason,
} from "@vetrix/domain";
import { getVeterinaryPack } from "@vetrix/pack";
import { writeAudit, type Actor } from "./clients";
import type { SqlClient } from "./sql-client";

const staffId = (a: Actor) => (a.type === "staff" ? a.id : null);

export interface CampaignRow {
  id: string;
  name: string;
  goal: string;
  audience: Audience;
  channels: CampaignChannel[];
  status: CampaignStatus;
  /** null = everyone who matches; a list = only these clients. */
  recipient_ids: string[] | null;
  send_at: Date | null;
  approved_at: Date | null;
  approved_by_name: string | null;
  created_at: Date;
  finished_at: Date | null;
  sent: number;
  skipped: number;
}

export interface CampaignContent {
  id: string;
  channel: CampaignChannel;
  version: number;
  source: "ai" | "staff";
  subject: string | null;
  body: string;
  approved: boolean;
  created_at: Date;
}

const CAMPAIGN_COLUMNS = `c.id, c.name, c.goal, c.audience, c.channels, c.status, c.recipient_ids, c.send_at, c.approved_at, c.created_at, c.finished_at,
  su.display_name AS approved_by_name,
  (SELECT count(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'sent')::int AS sent,
  (SELECT count(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'skipped')::int AS skipped`;

/** Newest first, a page at a time, with the total for the pager. */
export async function listCampaigns(db: SqlClient, locationId: string, options: { limit: number; offset: number }): Promise<{ rows: CampaignRow[]; total: number }> {
  const [list, count] = await Promise.all([
    db.query<CampaignRow>(
      `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns c LEFT JOIN staff_users su ON su.id = c.approved_by
       WHERE c.location_id = $1 ORDER BY c.created_at DESC, c.id LIMIT $2 OFFSET $3`,
      [locationId, Math.min(Math.max(options.limit, 1), 100), Math.max(options.offset, 0)],
    ),
    db.query<{ n: number }>(`SELECT count(*)::int AS n FROM campaigns WHERE location_id = $1`, [locationId]),
  ]);
  return { rows: list.rows, total: count.rows[0]?.n ?? 0 };
}

export async function getCampaign(db: SqlClient, locationId: string, id: string): Promise<CampaignRow & { content: CampaignContent[] }> {
  const { rows } = await db.query<CampaignRow>(
    `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns c LEFT JOIN staff_users su ON su.id = c.approved_by WHERE c.id = $1 AND c.location_id = $2`,
    [id, locationId],
  );
  if (!rows[0]) throw new NotFoundError("Campaign", id);
  const content = await db.query<CampaignContent>(
    `SELECT id, channel, version, source, subject, body, approved, created_at FROM campaign_content WHERE campaign_id = $1 ORDER BY channel, version DESC`,
    [id],
  );
  return { ...rows[0], content: content.rows };
}

/** Locks the campaign for a change and checks the status move is allowed. */
async function lockCampaign(
  db: SqlClient,
  locationId: string,
  id: string,
): Promise<{ status: CampaignStatus; goal: string; channels: CampaignChannel[]; audience: Audience; recipient_ids: string[] | null }> {
  const { rows } = await db.query<{ status: CampaignStatus; goal: string; channels: CampaignChannel[]; audience: Audience; recipient_ids: string[] | null }>(
    `SELECT status, goal, channels, audience, recipient_ids FROM campaigns WHERE id = $1 AND location_id = $2 FOR UPDATE`,
    [id, locationId],
  );
  if (!rows[0]) throw new NotFoundError("Campaign", id);
  return rows[0];
}

function editable(status: CampaignStatus) {
  if (status !== "draft" && status !== "approved" && status !== "scheduled") {
    throw new RuleViolationError("campaign.locked", "This campaign has started sending and can no longer be changed.");
  }
}

/** Any edit after approval sends the campaign back to draft: it must be approved again. */
async function backToDraft(db: SqlClient, id: string) {
  await db.query(`UPDATE campaign_content SET approved = false WHERE campaign_id = $1 AND approved`, [id]);
  await db.query(`UPDATE campaigns SET status = 'draft', approved_by = NULL, approved_at = NULL, send_at = NULL, updated_at = now() WHERE id = $1`, [id]);
}

export interface CampaignBasics {
  name: string;
  goal: string;
  channels: CampaignChannel[];
}

export function validateCampaignBasics(raw: Record<string, unknown>): CampaignBasics {
  const name = String(raw.name ?? "").trim();
  const goal = String(raw.goal ?? "").trim();
  const channels = [...new Set([raw.channels].flat().map(String))].filter((c): c is CampaignChannel => c === "sms" || c === "email");
  if (!name || name.length > 120) throw new ValidationError("Give the campaign a short name.", { field: "name" });
  if (goal.length < 10 || goal.length > 1000) throw new ValidationError("Describe the goal in a sentence or two: what you offer and to whom (10 to 1,000 characters).", { field: "goal" });
  if (channels.length === 0) throw new ValidationError("Choose text, email or both.", { field: "channels" });
  return { name, goal, channels };
}

export async function createCampaign(db: SqlClient, input: { locationId: string; basics: CampaignBasics; actor: Actor }): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO campaigns (location_id, name, goal, channels, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.locationId, input.basics.name, input.basics.goal, input.basics.channels, staffId(input.actor)],
  );
  const id = rows[0]!.id;
  await writeAudit(db, { locationId: input.locationId, actor: input.actor, action: "campaign.created", entityType: "campaign", entityId: id, changes: { ...input.basics } });
  return id;
}

export async function updateCampaignBasics(db: SqlClient, input: { locationId: string; id: string; basics: CampaignBasics; actor: Actor }): Promise<void> {
  const c = await lockCampaign(db, input.locationId, input.id);
  editable(c.status);
  if (c.status !== "draft") await backToDraft(db, input.id);
  await db.query(`UPDATE campaigns SET name = $2, goal = $3, channels = $4, updated_at = now() WHERE id = $1`, [input.id, input.basics.name, input.basics.goal, input.basics.channels]);
  await writeAudit(db, { locationId: input.locationId, actor: input.actor, action: "campaign.updated", entityType: "campaign", entityId: input.id, changes: { ...input.basics } });
}

export async function saveCampaignAudience(db: SqlClient, input: { locationId: string; id: string; audience: Audience; actor: Actor }): Promise<void> {
  const c = await lockCampaign(db, input.locationId, input.id);
  editable(c.status);
  if (c.status !== "draft") await backToDraft(db, input.id);
  await db.query(`UPDATE campaigns SET audience = $2, updated_at = now() WHERE id = $1`, [input.id, JSON.stringify(input.audience)]);
  await writeAudit(db, { locationId: input.locationId, actor: input.actor, action: "campaign.audience", entityType: "campaign", entityId: input.id, changes: { audience: input.audience } });
}

/**
 * Everyone who matches (null), or only the clients staff picked. Kept through
 * approval: approval covers the message, and each picked client must still
 * match the rules when sending starts. Ids from another location are dropped.
 */
export async function saveCampaignRecipients(db: SqlClient, input: { locationId: string; id: string; clientIds: string[] | null; actor: Actor }): Promise<{ chosen: number | null }> {
  const c = await lockCampaign(db, input.locationId, input.id);
  editable(c.status);
  let ids: string[] | null = null;
  if (input.clientIds) {
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM clients WHERE location_id = $1 AND id = ANY($2::uuid[])`, [input.locationId, input.clientIds]);
    ids = rows.map((r) => r.id);
    if (ids.length === 0) throw new ValidationError("Choose at least one client, or send to everyone who matches.");
  }
  await db.query(`UPDATE campaigns SET recipient_ids = $2, updated_at = now() WHERE id = $1`, [input.id, ids]);
  await writeAudit(db, {
    locationId: input.locationId,
    actor: input.actor,
    action: "campaign.recipients",
    entityType: "campaign",
    entityId: input.id,
    changes: ids ? { mode: "chosen", clients: ids.length } : { mode: "all" },
  });
  return { chosen: ids?.length ?? null };
}

// ---------- Audience ----------

/** What the audience rules can choose from at this location. */
export async function audienceOptions(db: SqlClient, locationId: string): Promise<{ species: string[]; services: { id: string; name: string }[] }> {
  const [species, services] = await Promise.all([
    db.query<{ species: string }>(`SELECT DISTINCT species FROM patients WHERE location_id = $1 AND status = 'active' ORDER BY species`, [locationId]),
    db.query<{ id: string; name: string }>(
      `SELECT DISTINCT ON (pack_service_id) pack_service_id AS id, name FROM services
       WHERE location_id = $1 AND pack_service_id IS NOT NULL AND category NOT IN ('end_of_life') ORDER BY pack_service_id, name`,
      [locationId],
    ),
  ]);
  return { species: species.rows.map((r) => r.species), services: services.rows };
}

/** Active pets and their owners, with what the audience rules and consent checks need. */
async function loadAudienceData(db: SqlClient, locationId: string, today: string, excludeCampaignId?: string): Promise<{ pets: AudiencePet[]; clients: Map<string, CampaignClient & { name: string }> }> {
  const [pets, clients] = await Promise.all([
    db.query<{ id: string; client_id: string; name: string; species: string; age_years: number | null; last_visit: string | null; next_vaccine: string | null; services: Record<string, string> | null }>(
      `SELECT p.id, p.client_id, p.name, p.species,
              CASE WHEN p.date_of_birth IS NOT NULL THEN ($2::date - p.date_of_birth) / 365.25
                   WHEN p.approx_age_months IS NOT NULL THEN p.approx_age_months / 12.0 END::float AS age_years,
              to_char(greatest(p.last_wellness_exam_at, v.last_visit), 'YYYY-MM-DD') AS last_visit,
              (SELECT to_char(min(x.due_at), 'YYYY-MM-DD') FROM (SELECT max(vr.due_at) AS due_at FROM vaccine_records vr WHERE vr.patient_id = p.id GROUP BY vr.vaccine_id) x) AS next_vaccine,
              v.services
       FROM patients p
       JOIN locations l ON l.id = p.location_id
       -- Last completed visit overall and per pack service, in clinic dates.
       LEFT JOIN LATERAL (
         SELECT max(d.last) AS last_visit,
                jsonb_object_agg(d.pack_service_id, to_char(d.last, 'YYYY-MM-DD')) FILTER (WHERE d.pack_service_id IS NOT NULL) AS services
         FROM (SELECT s.pack_service_id, max((a.start_at AT TIME ZONE l.timezone)::date) AS last
               FROM appointments a JOIN services s ON s.id = a.service_id
               WHERE a.patient_id = p.id AND a.status = 'completed'
               GROUP BY s.pack_service_id) d
       ) v ON true
       WHERE p.location_id = $1 AND p.status = 'active'`,
      [locationId, today],
    ),
    db.query<{ id: string; first_name: string; name: string; marketing_consent: boolean; sms_consent: boolean; email: string | null; flags: string[]; last_campaign_at: Date | null }>(
      `SELECT c.id, c.first_name, c.first_name || ' ' || c.last_name AS name, c.marketing_consent, c.sms_consent, c.email,
              coalesce((SELECT array_agg(f.flag) FROM client_flags f WHERE f.client_id = c.id), '{}') AS flags,
              (SELECT max(r.created_at) FROM campaign_recipients r WHERE r.client_id = c.id AND r.status = 'sent' AND r.campaign_id IS DISTINCT FROM $2::uuid
                 -- A simulated message (sandbox, or not on the test allowlist) never reached the client.
                 AND EXISTS (SELECT 1 FROM messages m WHERE m.id = r.message_id AND m.status <> 'simulated')) AS last_campaign_at
       FROM clients c WHERE c.location_id = $1`,
      [locationId, excludeCampaignId ?? null],
    ),
  ]);
  return {
    pets: pets.rows.map((p) => ({
      id: p.id,
      clientId: p.client_id,
      name: p.name,
      species: p.species,
      ageYears: p.age_years,
      lastVisitAt: p.last_visit,
      nextVaccineDueAt: p.next_vaccine,
      lastServiceAt: p.services ?? {},
    })),
    clients: new Map(
      clients.rows.map((c) => [
        c.id,
        { id: c.id, name: c.name, firstName: c.first_name, marketingConsent: c.marketing_consent, smsConsent: c.sms_consent, email: c.email, flags: c.flags, lastCampaignAt: c.last_campaign_at },
      ]),
    ),
  };
}

export interface AudiencePreview {
  /** Clients the campaign goes to: everyone matching, or the chosen ones who match. */
  clients: number;
  /** Clients the rules match, before any hand-picking. */
  matching: number;
  pets: number;
  perChannel: Partial<Record<CampaignChannel, { send: number; skipped: Partial<Record<SkipReason, number>> }>>;
  /** One page of who is included, by client name. */
  sample: { clientId: string; clientName: string; petNames: string; chosen: boolean; channels: Partial<Record<CampaignChannel, SkipReason | null>> }[];
  sampleOffset: number;
  /** Rows the sample pages through (all matching clients, narrowed by the search). */
  sampleTotal: number;
}

/** Who the rules select today and who could actually receive it on each channel. */
export async function previewAudience(
  db: SqlClient,
  input: {
    locationId: string;
    audience: Audience;
    channels: CampaignChannel[];
    today: string;
    now: number;
    campaignId?: string;
    sampleOffset?: number;
    sampleLimit?: number;
    /** Counts only these clients (null or absent = everyone who matches). The sample still lists every match. */
    recipientIds?: string[] | null;
    /** Narrows the sample by client or pet name. */
    search?: string;
  },
): Promise<AudiencePreview> {
  const data = await loadAudienceData(db, input.locationId, input.today, input.campaignId);
  const selected = selectAudience(input.audience, data.pets, input.today);
  const chosen = limitToChosen(selected, input.recipientIds ?? null);
  const sampleOffset = Math.max(input.sampleOffset ?? 0, 0);
  const sampleLimit = Math.min(Math.max(input.sampleLimit ?? 20, 1), 100);
  const search = (input.search ?? "").trim().toLowerCase().slice(0, 100);
  const preview: AudiencePreview = { clients: chosen.size, matching: selected.size, pets: 0, perChannel: {}, sample: [], sampleOffset, sampleTotal: 0 };
  // By client name, so pages of "who is included" are stable.
  const ordered = [...selected].sort(([a], [b]) => (data.clients.get(a)?.name ?? "").localeCompare(data.clients.get(b)?.name ?? "") || a.localeCompare(b));
  let index = 0;
  for (const ch of input.channels) preview.perChannel[ch] = { send: 0, skipped: {} };
  for (const [clientId, pets] of ordered) {
    const client = data.clients.get(clientId);
    if (!client) continue;
    const isChosen = chosen.has(clientId);
    const petNames = joinPetNames(pets.map((p) => p.name));
    const row: AudiencePreview["sample"][number] = { clientId, clientName: client.name, petNames, chosen: isChosen, channels: {} };
    if (isChosen) preview.pets += pets.length;
    for (const ch of input.channels) {
      const why = campaignEligibility(client, ch, input.now);
      row.channels[ch] = why;
      if (!isChosen) continue;
      const bucket = preview.perChannel[ch]!;
      if (why) bucket.skipped[why] = (bucket.skipped[why] ?? 0) + 1;
      else bucket.send += 1;
    }
    if (search && !`${client.name} ${petNames}`.toLowerCase().includes(search)) continue;
    if (index >= sampleOffset && index < sampleOffset + sampleLimit) preview.sample.push(row);
    index += 1;
  }
  preview.sampleTotal = index;
  return preview;
}

// ---------- Content ----------

/** The facts a campaign may state: the goal and the clinic's own details. */
export async function campaignFacts(db: SqlClient, locationId: string, goal: string): Promise<{ facts: string; clinicName: string; clinicPhone: string | null }> {
  const { rows } = await db.query<{ name: string; main_phone: string | null; address: string | null; website: string | null }>(
    `SELECT name, main_phone, address, website FROM locations WHERE id = $1`,
    [locationId],
  );
  const l = rows[0];
  if (!l) throw new NotFoundError("Location", locationId);
  const phone = l.main_phone ? formatUsPhone(l.main_phone) : null;
  const facts = [`Goal: ${goal}`, `Clinic: ${l.name}`, phone ? `Phone: ${phone} ${l.main_phone}` : "", l.address ? `Address: ${l.address}` : "", l.website ? `Website: ${l.website}` : ""].filter(Boolean).join(". ");
  return { facts, clinicName: l.name, clinicPhone: phone };
}

function formatUsPhone(p: string): string {
  const d = p.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p;
}

export const forbiddenCampaignTerms = (): readonly string[] => getVeterinaryPack().labels.forbidden_terms;

/** Saves a new version of a campaign's text or email. Staff edits and AI drafts are both kept. */
export async function saveCampaignContent(
  db: SqlClient,
  input: { locationId: string; id: string; channel: CampaignChannel; source: "ai" | "staff"; subject: string | null; body: string; actor: Actor },
): Promise<{ version: number; issues: CopyIssue[] }> {
  const c = await lockCampaign(db, input.locationId, input.id);
  editable(c.status);
  if (!c.channels.includes(input.channel)) throw new ValidationError("This campaign does not use that channel.");
  const body = input.body.trim();
  const subject = input.channel === "email" ? (input.subject ?? "").trim() || null : null;
  if (!body) throw new ValidationError("Write the message first.", { field: "body" });
  if (body.length > 5000 || (subject?.length ?? 0) > 150) throw new ValidationError("The message is too long.", { field: "body" });
  if (c.status !== "draft") await backToDraft(db, input.id);
  const { rows } = await db.query<{ version: number }>(
    `INSERT INTO campaign_content (campaign_id, channel, version, source, subject, body, created_by)
     SELECT $1, $2, coalesce(max(version), 0) + 1, $3, $4, $5, $6 FROM campaign_content WHERE campaign_id = $1 AND channel = $2
     RETURNING version`,
    [input.id, input.channel, input.source, subject, body, staffId(input.actor)],
  );
  const { facts } = await campaignFacts(db, input.locationId, c.goal);
  return { version: rows[0]!.version, issues: checkCampaignCopy({ channel: input.channel, subject, body }, facts, forbiddenCampaignTerms()) };
}

/**
 * Approves the latest version of each channel's message. Refused while the
 * copy check finds a problem, or when a channel has no message yet.
 */
export async function approveCampaign(db: SqlClient, input: { locationId: string; id: string; actor: Actor }): Promise<void> {
  const c = await lockCampaign(db, input.locationId, input.id);
  if (!canChangeCampaign(c.status, "approved")) throw new RuleViolationError("campaign.status", "Only a draft can be approved.");
  if (!c.audience.conditions?.length) throw new RuleViolationError("campaign.audience", "Choose who the campaign goes to first.");
  const { facts } = await campaignFacts(db, input.locationId, c.goal);
  const latest = await db.query<{ id: string; channel: CampaignChannel; subject: string | null; body: string }>(
    `SELECT DISTINCT ON (channel) id, channel, subject, body FROM campaign_content WHERE campaign_id = $1 ORDER BY channel, version DESC`,
    [input.id],
  );
  for (const ch of c.channels) {
    const content = latest.rows.find((r) => r.channel === ch);
    if (!content) throw new RuleViolationError("campaign.content", `Write the ${ch === "sms" ? "text message" : "email"} first.`);
    const issues = checkCampaignCopy({ channel: ch, subject: content.subject, body: content.body }, facts, forbiddenCampaignTerms());
    if (issues.length) throw new RuleViolationError("campaign.copy", `Fix the ${ch === "sms" ? "text message" : "email"} first: ${issues[0]!.text}`);
  }
  const ids = latest.rows.filter((r) => c.channels.includes(r.channel)).map((r) => r.id);
  await db.query(`UPDATE campaign_content SET approved = (id = ANY($2::uuid[])) WHERE campaign_id = $1`, [input.id, ids]);
  await db.query(`UPDATE campaigns SET status = 'approved', approved_by = $2, approved_at = now(), updated_at = now() WHERE id = $1`, [input.id, staffId(input.actor)]);
  await writeAudit(db, { locationId: input.locationId, actor: input.actor, action: "campaign.approved", entityType: "campaign", entityId: input.id, changes: { content: ids } });
}

/** Sends now (sendAt = now) or at a later time. Only an approved campaign. */
export async function scheduleCampaign(db: SqlClient, input: { locationId: string; id: string; sendAt: Date; now: number; actor: Actor }): Promise<void> {
  const c = await lockCampaign(db, input.locationId, input.id);
  if (!canChangeCampaign(c.status, "scheduled")) throw new RuleViolationError("campaign.status", "Approve the campaign before sending it.");
  if (c.recipient_ids && c.recipient_ids.length === 0) throw new RuleViolationError("campaign.recipients", "Choose at least one client, or send to everyone who matches.");
  if (input.sendAt.getTime() < input.now - 60_000 || input.sendAt.getTime() > input.now + 90 * 86_400_000) {
    throw new ValidationError("Choose a time from now up to 90 days ahead.", { field: "sendAt" });
  }
  await db.query(`UPDATE campaigns SET status = 'scheduled', send_at = $2, updated_at = now() WHERE id = $1`, [input.id, input.sendAt]);
  await writeAudit(db, { locationId: input.locationId, actor: input.actor, action: "campaign.scheduled", entityType: "campaign", entityId: input.id, changes: { send_at: input.sendAt.toISOString() } });
}

/** Stops a campaign: nothing more is sent. Messages already sent stay in the log. */
export async function cancelCampaign(db: SqlClient, input: { locationId: string; id: string; actor: Actor }): Promise<void> {
  const c = await lockCampaign(db, input.locationId, input.id);
  if (!canChangeCampaign(c.status, "cancelled")) throw new ConflictError("This campaign has already finished.");
  await db.query(`UPDATE campaigns SET status = 'cancelled', finished_at = now(), updated_at = now() WHERE id = $1`, [input.id]);
  await writeAudit(db, { locationId: input.locationId, actor: input.actor, action: "campaign.cancelled", entityType: "campaign", entityId: input.id });
}

/** Back to draft from approved or scheduled (e.g. to change the time or the text). */
export async function reopenCampaign(db: SqlClient, input: { locationId: string; id: string; actor: Actor }): Promise<void> {
  const c = await lockCampaign(db, input.locationId, input.id);
  if (!canChangeCampaign(c.status, "draft")) throw new RuleViolationError("campaign.status", "This campaign can no longer be changed.");
  await backToDraft(db, input.id);
  await writeAudit(db, { locationId: input.locationId, actor: input.actor, action: "campaign.reopened", entityType: "campaign", entityId: input.id });
}

// ---------- Sending ----------

export interface CampaignSendValues {
  clinicName: string;
  clinicPhone: string;
  /** The clinic's online booking page, or null to point clients to the phone. */
  bookingUrl: string | null;
  /** Base of the email unsubscribe link: <base>/<token>. */
  unsubscribeBase: string;
}

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

/** Consent and contact details for the clients a run may message. */
async function loadCampaignClients(db: SqlClient, clientIds: string[], campaignId: string): Promise<Map<string, CampaignClient>> {
  if (clientIds.length === 0) return new Map();
  const { rows } = await db.query<{ id: string; first_name: string; marketing_consent: boolean; sms_consent: boolean; email: string | null; flags: string[]; last_campaign_at: Date | null }>(
    `SELECT c.id, c.first_name, c.marketing_consent, c.sms_consent, c.email,
            coalesce((SELECT array_agg(f.flag) FROM client_flags f WHERE f.client_id = c.id), '{}') AS flags,
            (SELECT max(r.created_at) FROM campaign_recipients r WHERE r.client_id = c.id AND r.status = 'sent' AND r.campaign_id <> $2
               AND EXISTS (SELECT 1 FROM messages m WHERE m.id = r.message_id AND m.status <> 'simulated')) AS last_campaign_at
     FROM clients c WHERE c.id = ANY($1::uuid[])`,
    [clientIds, campaignId],
  );
  return new Map(
    rows.map((c) => [c.id, { id: c.id, firstName: c.first_name, marketingConsent: c.marketing_consent, smsConsent: c.sms_consent, email: c.email, flags: c.flags, lastCampaignAt: c.last_campaign_at }]),
  );
}

/**
 * Sends what is due: scheduled campaigns whose time has come and campaigns
 * still sending.
 *
 * 1. When a campaign starts, its audience is fixed: one 'pending' row per
 *    matching client (or matching chosen client) and channel, with the pets it is about. Clients who
 *    match later are not added (decided 24 Nov 2026).
 * 2. Each run works through the pending rows. Consent, do-not-contact, the
 *    7-day limit and the pets still being active are checked again as each
 *    message goes out; a pet no longer active is left out of the message.
 *
 * At most CAMPAIGN_BATCH_SIZE messages per location per run. In quiet hours
 * texts wait; emails go. Sandbox: saved as simulated.
 */
export async function runDueCampaigns(
  db: SqlClient,
  input: {
    locationId: string;
    now: number;
    today: string;
    sandbox: boolean;
    quietHours: boolean;
    values: CampaignSendValues;
    /** "Send now" sends only that campaign; the scheduler (no id) sends every due one. */
    campaignId?: string;
  },
): Promise<{ campaigns: number; sent: number; skipped: number; finished: number }> {
  const result = { campaigns: 0, sent: 0, skipped: 0, finished: 0 };
  const { rows: due } = await db.query<{ id: string; status: CampaignStatus; audience: Audience; channels: CampaignChannel[]; recipient_ids: string[] | null; audience_fixed_at: Date | null }>(
    `SELECT id, status, audience, channels, recipient_ids, audience_fixed_at FROM campaigns
     WHERE location_id = $1 AND (status = 'sending' OR (status = 'scheduled' AND send_at <= $2))
       AND ($3::uuid IS NULL OR id = $3::uuid)
     ORDER BY send_at FOR UPDATE SKIP LOCKED`,
    [input.locationId, new Date(input.now), input.campaignId ?? null],
  );
  let budget = CAMPAIGN_BATCH_SIZE;
  for (const c of due) {
    if (budget <= 0) break;
    result.campaigns += 1;
    if (c.status === "scheduled") {
      await db.query(`UPDATE campaigns SET status = 'sending', started_at = now(), updated_at = now() WHERE id = $1`, [c.id]);
      await writeAudit(db, { locationId: input.locationId, actor: { type: "system", id: null }, action: "campaign.sending", entityType: "campaign", entityId: c.id });
    }

    // 1. Fix the audience once. Rows already written (e.g. by a run before this
    //    rule existed) stay as they are.
    if (!c.audience_fixed_at) {
      const data = await loadAudienceData(db, input.locationId, input.today, c.id);
      // Everyone who matches, or only the clients staff picked (if they still match).
      const selected = [...limitToChosen(selectAudience(c.audience, data.pets, input.today), c.recipient_ids)];
      const snap = selected.flatMap(([clientId, pets]) => c.channels.map((channel) => ({ clientId, channel, petIds: pets.map((p) => p.id), petNames: joinPetNames(pets.map((p) => p.name)) })));
      if (snap.length) {
        await db.query(
          `INSERT INTO campaign_recipients (campaign_id, client_id, channel, status, pet_ids, pet_names)
           SELECT $1, u.client_id, u.channel, 'pending', string_to_array(u.pet_ids, ',')::uuid[], u.pet_names
           FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[]) AS u(client_id, channel, pet_ids, pet_names)
           ON CONFLICT (campaign_id, client_id, channel) DO NOTHING`,
          [c.id, snap.map((r) => r.clientId), snap.map((r) => r.channel), snap.map((r) => r.petIds.join(",")), snap.map((r) => r.petNames)],
        );
      }
      await db.query(`UPDATE campaigns SET audience_fixed_at = now() WHERE id = $1`, [c.id]);
      await writeAudit(db, { locationId: input.locationId, actor: { type: "system", id: null }, action: "campaign.audience_fixed", entityType: "campaign", entityId: c.id, changes: { clients: selected.length } });
    }

    // 2. Work through the waiting rows.
    const { rows: pending } = await db.query<{ id: string; client_id: string; channel: CampaignChannel; pet_ids: string[] }>(
      `SELECT id, client_id, channel, pet_ids FROM campaign_recipients WHERE campaign_id = $1 AND status = 'pending' ORDER BY created_at, client_id, channel`,
      [c.id],
    );
    const content = await db.query<{ channel: CampaignChannel; subject: string | null; body: string }>(
      `SELECT channel, subject, body FROM campaign_content WHERE campaign_id = $1 AND approved`,
      [c.id],
    );
    const approved = new Map(content.rows.map((r) => [r.channel, r]));
    const clients = await loadCampaignClients(db, [...new Set(pending.map((p) => p.client_id))], c.id);
    const activePets = new Map(
      (await db.query<{ id: string; name: string }>(`SELECT id, name FROM patients WHERE id = ANY($1::uuid[]) AND status = 'active'`, [[...new Set(pending.flatMap((p) => p.pet_ids))]])).rows.map(
        (p) => [p.id, p.name],
      ),
    );

    let waiting = 0;
    const skipped: { id: string; reason: SkipReason }[] = [];
    const sent: { id: string; messageId: string; petNames: string; token: string | null }[] = [];
    const messages: { id: string; clientId: string; channel: CampaignChannel; subject: string | null; body: string }[] = [];
    for (const r of pending) {
      if (r.channel === "sms" && input.quietHours) {
        waiting += 1;
        continue;
      }
      const client = clients.get(r.client_id);
      const pets = r.pet_ids.map((id) => activePets.get(id)).filter((n): n is string => Boolean(n));
      const reason: SkipReason | null = !client ? "do_not_contact" : pets.length === 0 ? "pet_not_active" : campaignEligibility(client, r.channel, input.now);
      if (reason) {
        skipped.push({ id: r.id, reason });
        continue;
      }
      if (budget <= 0) {
        waiting += 1;
        continue;
      }
      const msg = approved.get(r.channel);
      if (!msg) throw new RuleViolationError("campaign.content", "The campaign has no approved message for this channel.");
      const token = r.channel === "email" ? randomBytes(24).toString("base64url") : null;
      const petNames = joinPetNames(pets);
      const values = {
        client_first_name: client!.firstName,
        pet_names: petNames,
        clinic_name: input.values.clinicName,
        clinic_phone: input.values.clinicPhone,
        booking_link: input.values.bookingUrl ?? `call ${input.values.clinicPhone}`,
      };
      let body = fillCampaignMessage(msg.body, r.channel, values);
      if (token) body += `\n\n--\nYou are getting this because you agreed to hear from ${input.values.clinicName}. Stop these emails: ${input.values.unsubscribeBase}/${token}`;
      const messageId = randomUUID();
      messages.push({ id: messageId, clientId: r.client_id, channel: r.channel, subject: msg.subject ? fillCampaignMessage(msg.subject, "email", values) : null, body });
      sent.push({ id: r.id, messageId, petNames, token });
      budget -= 1;
    }

    if (messages.length) {
      await db.query(
        `INSERT INTO messages (id, location_id, client_id, channel, template_key, subject, body, status, sent_at)
         SELECT u.id, $1, u.client_id, u.channel, 'campaign', u.subject, u.body, $2, $3
         FROM unnest($4::uuid[], $5::uuid[], $6::text[], $7::text[], $8::text[]) AS u(id, client_id, channel, subject, body)`,
        [input.locationId, input.sandbox ? "simulated" : "queued", input.sandbox ? new Date(input.now) : null,
         messages.map((m) => m.id), messages.map((m) => m.clientId), messages.map((m) => m.channel), messages.map((m) => m.subject), messages.map((m) => m.body)],
      );
      // created_at marks when the client was messaged (the 7-day limit reads it).
      await db.query(
        `UPDATE campaign_recipients r SET status = 'sent', message_id = u.message_id, pet_names = u.pet_names, unsubscribe_token_hash = u.token_hash, created_at = now()
         FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[]) AS u(id, message_id, pet_names, token_hash) WHERE r.id = u.id`,
        [sent.map((x) => x.id), sent.map((x) => x.messageId), sent.map((x) => x.petNames), sent.map((x) => (x.token ? hashToken(x.token) : null))],
      );
    }
    if (skipped.length) {
      await db.query(
        `UPDATE campaign_recipients r SET status = 'skipped', skip_reason = u.reason, created_at = now()
         FROM unnest($1::uuid[], $2::text[]) AS u(id, reason) WHERE r.id = u.id`,
        [skipped.map((x) => x.id), skipped.map((x) => x.reason)],
      );
    }
    result.sent += messages.length;
    result.skipped += skipped.length;
    if (waiting === 0) {
      await db.query(`UPDATE campaigns SET status = 'sent', finished_at = now(), updated_at = now() WHERE id = $1`, [c.id]);
      const totals = await db.query<{ sent: number; skipped: number }>(
        `SELECT count(*) FILTER (WHERE status = 'sent')::int AS sent, count(*) FILTER (WHERE status = 'skipped')::int AS skipped FROM campaign_recipients WHERE campaign_id = $1`,
        [c.id],
      );
      await writeAudit(db, { locationId: input.locationId, actor: { type: "system", id: null }, action: "campaign.sent", entityType: "campaign", entityId: c.id, changes: { ...totals.rows[0] } });
      result.finished += 1;
    }
  }
  return result;
}

// ---------- Unsubscribe ----------

/** The client and clinic behind an unsubscribe link, or null for an unknown link. */
export async function unsubscribeLink(db: SqlClient, token: string): Promise<{ clientFirstName: string; clinicName: string; alreadyOff: boolean } | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const { rows } = await db.query<{ first_name: string; clinic: string; marketing_consent: boolean }>(
    `SELECT c.first_name, l.name AS clinic, c.marketing_consent FROM campaign_recipients r
     JOIN clients c ON c.id = r.client_id JOIN locations l ON l.id = c.location_id WHERE r.unsubscribe_token_hash = $1`,
    [hashToken(token)],
  );
  const r = rows[0];
  return r ? { clientFirstName: r.first_name, clinicName: r.clinic, alreadyOff: !r.marketing_consent } : null;
}

/** Turns off marketing for the client behind the link (recorded as a consent change). Safe to repeat. */
export async function unsubscribeByLink(db: SqlClient, token: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return false;
  const { rows } = await db.query<{ client_id: string; location_id: string; recipient_id: string }>(
    `SELECT r.client_id, c.location_id, r.id AS recipient_id FROM campaign_recipients r JOIN clients c ON c.id = r.client_id WHERE r.unsubscribe_token_hash = $1`,
    [hashToken(token)],
  );
  const r = rows[0];
  if (!r) return false;
  const changed = await db.query(`UPDATE clients SET marketing_consent = false WHERE id = $1 AND marketing_consent RETURNING 1`, [r.client_id]);
  await db.query(`UPDATE campaign_recipients SET unsubscribed_at = coalesce(unsubscribed_at, now()) WHERE id = $1`, [r.recipient_id]);
  if (changed.rows.length) {
    await db.query(`INSERT INTO client_consents (client_id, consent_type, granted, source) VALUES ($1, 'marketing', false, 'email_unsubscribe')`, [r.client_id]);
    await writeAudit(db, { locationId: r.location_id, actor: { type: "client", id: null }, action: "client.marketing_unsubscribed", entityType: "client", entityId: r.client_id });
  }
  return true;
}

// ---------- Results ----------

export interface CampaignResults {
  sent: number;
  delivered: number;
  failed: number;
  pending: number;
  simulated: number;
  /** In the fixed audience, not reached yet (e.g. texts waiting for quiet hours to end). */
  waiting: number;
  skipped: Partial<Record<SkipReason, number>>;
  unsubscribed: number;
  /** Clients who booked a visit within 14 days of their message. */
  booked: number;
  /** Everyone in the campaign (rows), for the pager; `recipients` is one page. */
  recipientsTotal: number;
  recipients: { clientName: string; petNames: string | null; channel: CampaignChannel; status: string; skipReason: SkipReason | null; messageStatus: string | null }[];
}

/**
 * The numbers across everyone in the campaign, and one page of the people
 * (`recipientsTotal` for the pager).
 */
export async function campaignResults(db: SqlClient, locationId: string, id: string, page: { limit: number; offset: number } = { limit: 25, offset: 0 }): Promise<CampaignResults> {
  const { rows } = await db.query<{ client_name: string; client_id: string; pet_names: string | null; channel: CampaignChannel; status: string; skip_reason: SkipReason | null; message_status: string | null; unsubscribed: boolean; booked: boolean }>(
    `SELECT c.first_name || ' ' || c.last_name AS client_name, r.client_id, r.pet_names, r.channel, r.status, r.skip_reason, m.status AS message_status,
            r.unsubscribed_at IS NOT NULL AS unsubscribed,
            r.status = 'sent' AND EXISTS (
              SELECT 1 FROM appointments a JOIN appointment_status_history h ON h.appointment_id = a.id AND h.from_status IS NULL
              WHERE a.client_id = r.client_id AND h.changed_at BETWEEN r.created_at AND r.created_at + interval '14 days'
            ) AS booked
     FROM campaign_recipients r JOIN campaigns k ON k.id = r.campaign_id JOIN clients c ON c.id = r.client_id
     LEFT JOIN messages m ON m.id = r.message_id
     WHERE r.campaign_id = $1 AND k.location_id = $2
     ORDER BY r.status DESC, client_name, r.client_id, r.channel`,
    [id, locationId],
  );
  const out: CampaignResults = { sent: 0, delivered: 0, failed: 0, pending: 0, simulated: 0, waiting: 0, skipped: {}, unsubscribed: 0, booked: 0, recipients: [], recipientsTotal: rows.length };
  const limit = Math.min(Math.max(page.limit, 1), 100);
  const offset = Math.max(page.offset, 0);
  const bookedClients = new Set<string>();
  for (const r of rows) {
    if (r.status === "skipped" && r.skip_reason) out.skipped[r.skip_reason] = (out.skipped[r.skip_reason] ?? 0) + 1;
    if (r.status === "pending") out.waiting += 1;
    if (r.message_status === "sent" || r.message_status === "delivered") out.sent += 1;
    if (r.message_status === "delivered") out.delivered += 1;
    if (r.message_status === "failed") out.failed += 1;
    if (r.message_status === "queued") out.pending += 1;
    if (r.message_status === "simulated") out.simulated += 1;
    if (r.unsubscribed) out.unsubscribed += 1;
    if (r.booked) bookedClients.add(r.client_id);
  }
  for (const r of rows.slice(offset, offset + limit)) {
    out.recipients.push({ clientName: r.client_name, petNames: r.pet_names, channel: r.channel, status: r.status, skipReason: r.skip_reason, messageStatus: r.message_status });
  }
  out.booked = bookedClients.size;
  return out;
}

// ---------- Test sends ----------

/** A test email was sent (or refused) for a campaign: kept in the audit log, nowhere else. */
export async function logCampaignTestSend(db: SqlClient, input: { locationId: string; id: string; actor: Actor; to: string[]; ok: boolean; sender: "clinic" | "provider_test" }): Promise<void> {
  await writeAudit(db, {
    locationId: input.locationId,
    actor: input.actor,
    action: "campaign.test_sent",
    entityType: "campaign",
    entityId: input.id,
    changes: { to: input.to, ok: input.ok, sender: input.sender },
  });
}
