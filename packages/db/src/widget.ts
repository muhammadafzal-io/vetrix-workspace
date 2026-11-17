// Public booking widget on the clinic's website: texted codes, short widget
// sessions, a client's pets and what they're due for, new clients, and the
// routine visits a client may book themselves (same strict rules as the AI
// front desk). Codes and session tokens are stored only as hashes.
import { createHash, randomBytes, randomInt } from "node:crypto";
import {
  ageInMonths,
  canBookOnline,
  checkEligibility,
  dueReminders,
  localParts,
  normalizePhone,
  serviceForRule,
  validateNewClient,
  ValidationError,
  WIDGET,
  type NewClientForm,
} from "@vetrix/domain";
import { getVeterinaryPack } from "@vetrix/pack";
import { createClient, createPatient, writeAudit, type Actor } from "./clients";
import { bookOnline, onlineTimes, type OnlineBookResult, type OnlineTimesResult } from "./booking-links";
import { loadPatientForBooking, loadService } from "./booking";
import { loadRetentionInput } from "./retention";
import type { SqlClient } from "./sql-client";

const sha = (text: string) => createHash("sha256").update(text).digest("base64url");

// ---------- The clinic ----------

export interface WidgetClinic {
  locationId: string;
  name: string;
  address: string | null;
  phone: string | null;
  timezone: string;
  aiName: string;
  open: boolean;
  /** Where to go in an emergency when closed (pack after-hours default). */
  er: { name: string; phone: string; address: string } | null;
  origins: string[];
}

/** Locations with the widget turned on (most organizations have one). */
export async function widgetLocations(db: SqlClient): Promise<{ id: string; name: string }[]> {
  const { rows } = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM locations WHERE widget_enabled AND status <> 'closed' ORDER BY name`,
  );
  return rows;
}

export async function widgetClinic(db: SqlClient, locationId: string, now: number): Promise<WidgetClinic | null> {
  const { rows } = await db.query<{
    name: string; address: string | null; main_phone: string | null; timezone: string; widget_enabled: boolean; widget_origins: string[];
    ai_persona_name: string | null; er_name: string | null; er_phone: string | null; er_address: string | null;
  }>(
    `SELECT l.name, l.address, l.main_phone, l.timezone, l.widget_enabled, l.widget_origins, ps.ai_persona_name, ah.er_name, ah.er_phone, ah.er_address
     FROM locations l LEFT JOIN location_phone_settings ps ON ps.location_id = l.id LEFT JOIN location_after_hours ah ON ah.location_id = l.id
     WHERE l.id = $1 AND l.status <> 'closed'`,
    [locationId],
  );
  const l = rows[0];
  if (!l || !l.widget_enabled) return null;
  const here = localParts(now, l.timezone);
  const [hours, holiday] = await Promise.all([
    db.query<{ weekday: number; opens: string; closes: string }>(
      `SELECT weekday, to_char(opens_at, 'HH24:MI') AS opens, to_char(closes_at, 'HH24:MI') AS closes FROM location_hours WHERE location_id = $1`,
      [locationId],
    ),
    db.query(`SELECT 1 FROM location_holidays WHERE location_id = $1 AND holiday_date = $2`, [locationId, here.date]),
  ]);
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const open = holiday.rows.length === 0 && hours.rows.some((h) => h.weekday === here.weekday && toMin(h.opens) <= here.minutes && here.minutes < toMin(h.closes));
  return {
    locationId,
    name: l.name,
    address: l.address,
    phone: l.main_phone,
    timezone: l.timezone,
    aiName: l.ai_persona_name ?? getVeterinaryPack().brand.ai_persona?.default_name ?? "Riley",
    open,
    er: l.er_name && l.er_phone && l.er_address ? { name: l.er_name, phone: l.er_phone, address: l.er_address } : null,
    origins: l.widget_origins,
  };
}

// ---------- Texted codes ----------

export type SendCodeResult =
  | { status: "sent"; mobile: string; code: string; clientName: string | null }
  | { status: "wait"; seconds: number }
  | { status: "limit" }
  /** The number replied STOP or asked not to be contacted: no texts. */
  | { status: "no_text" };

/**
 * Makes a code for a mobile number. The caller texts it (live) or shows it
 * (Sandbox). Limits: one per 30 seconds, three per hour per number.
 */
export async function startWidgetCode(
  db: SqlClient,
  /** hourlyLimit: off in Sandbox, where nothing is texted. */
  input: { locationId: string; mobile: string; now: number; hourlyLimit?: boolean },
): Promise<SendCodeResult> {
  const mobile = normalizePhone(input.mobile);
  const client = await db.query<{ first_name: string; sms_consent: boolean; dnc: boolean }>(
    `SELECT c.first_name, c.sms_consent,
            EXISTS (SELECT 1 FROM client_flags f WHERE f.client_id = c.id AND f.flag = 'do_not_contact') AS dnc
     FROM clients c WHERE c.location_id = $1 AND c.mobile = $2`,
    [input.locationId, mobile],
  );
  const known = client.rows[0];
  if (known && (!known.sms_consent || known.dnc)) return { status: "no_text" };
  const recent = await db.query<{ created_at: Date }>(
    `SELECT created_at FROM widget_verifications WHERE location_id = $1 AND mobile = $2 AND created_at > $3 ORDER BY created_at DESC`,
    [input.locationId, mobile, new Date(input.now - 3_600_000)],
  );
  const last = recent.rows[0]?.created_at.getTime();
  if (last && input.now - last < WIDGET.resendSeconds * 1000) return { status: "wait", seconds: Math.ceil((WIDGET.resendSeconds * 1000 - (input.now - last)) / 1000) };
  if (input.hourlyLimit !== false && recent.rows.length >= WIDGET.sendsPerHour) return { status: "limit" };
  const code = String(randomInt(0, 10 ** WIDGET.codeLength)).padStart(WIDGET.codeLength, "0");
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO widget_verifications (location_id, mobile, code_hash, created_at, expires_at) VALUES ($1, $2, '', $3, $4) RETURNING id`,
    [input.locationId, mobile, new Date(input.now), new Date(input.now + WIDGET.codeMinutes * 60_000)],
  );
  await db.query(`UPDATE widget_verifications SET code_hash = $2 WHERE id = $1`, [rows[0]!.id, sha(`${rows[0]!.id}:${code}`)]);
  return { status: "sent", mobile, code, clientName: known?.first_name ?? null };
}

export type VerifyCodeResult = { status: "ok"; token: string; session: WidgetSession } | { status: "wrong"; triesLeft: number } | { status: "expired" };

/** Checks the latest code for the number; a right code opens a widget session. */
export async function verifyWidgetCode(db: SqlClient, input: { locationId: string; mobile: string; code: string; now: number }): Promise<VerifyCodeResult> {
  const mobile = normalizePhone(input.mobile);
  const { rows } = await db.query<{ id: string; code_hash: string; attempts: number; expires_at: Date; verified_at: Date | null }>(
    `SELECT id, code_hash, attempts, expires_at, verified_at FROM widget_verifications
     WHERE location_id = $1 AND mobile = $2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [input.locationId, mobile],
  );
  const v = rows[0];
  if (!v || v.verified_at || v.expires_at.getTime() < input.now || v.attempts >= WIDGET.maxAttempts) return { status: "expired" };
  if (sha(`${v.id}:${input.code}`) !== v.code_hash) {
    await db.query(`UPDATE widget_verifications SET attempts = attempts + 1 WHERE id = $1`, [v.id]);
    const left = WIDGET.maxAttempts - v.attempts - 1;
    return left > 0 ? { status: "wrong", triesLeft: left } : { status: "expired" };
  }
  await db.query(`UPDATE widget_verifications SET verified_at = $2 WHERE id = $1`, [v.id, new Date(input.now)]);
  const client = await db.query<{ id: string }>(`SELECT id FROM clients WHERE location_id = $1 AND mobile = $2`, [input.locationId, mobile]);
  const token = randomBytes(24).toString("base64url");
  await db.query(
    `INSERT INTO widget_sessions (location_id, token_hash, mobile, client_id, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.locationId, sha(token), mobile, client.rows[0]?.id ?? null, new Date(input.now), new Date(input.now + WIDGET.sessionMinutes * 60_000)],
  );
  const session = await widgetSession(db, { locationId: input.locationId, token, now: input.now });
  return { status: "ok", token, session: session! };
}

// ---------- Sessions ----------

export interface WidgetSession {
  id: string;
  mobile: string;
  clientId: string | null;
}

export async function widgetSession(db: SqlClient, input: { locationId: string; token: string; now: number }): Promise<WidgetSession | null> {
  if (!/^[A-Za-z0-9_-]{32}$/.test(input.token)) return null;
  const { rows } = await db.query<{ id: string; mobile: string; client_id: string | null; expires_at: Date }>(
    `SELECT id, mobile, client_id, expires_at FROM widget_sessions WHERE token_hash = $1 AND location_id = $2`,
    [sha(input.token), input.locationId],
  );
  const s = rows[0];
  if (!s || s.expires_at.getTime() < input.now) return null;
  return { id: s.id, mobile: s.mobile, clientId: s.client_id };
}

// ---------- The client's pets ----------

export interface WidgetPet {
  id: string;
  name: string;
  species: string;
  ageText: string | null;
  /** The reminder the clinic has for this pet, soonest first. */
  due: { label: string; dueAt: string; overdue: boolean; serviceId: string | null } | null;
  /** Next visit already on the schedule. */
  upcoming: { start: Date; serviceName: string } | null;
}

export interface WidgetMe {
  firstName: string;
  pets: WidgetPet[];
}

export async function widgetMe(db: SqlClient, input: { locationId: string; clientId: string; now: number; timezone: string }): Promise<WidgetMe> {
  const today = localParts(input.now, input.timezone).date;
  const [client, pets, upcoming, retention, services] = await Promise.all([
    db.query<{ first_name: string }>(`SELECT first_name FROM clients WHERE id = $1 AND location_id = $2`, [input.clientId, input.locationId]),
    db.query<{ id: string; name: string; species: string; dob: string | null; approx: number | null }>(
      `SELECT id, name, species, to_char(date_of_birth, 'YYYY-MM-DD') AS dob, approx_age_months AS approx
       FROM patients WHERE client_id = $1 AND location_id = $2 AND status = 'active' ORDER BY name`,
      [input.clientId, input.locationId],
    ),
    db.query<{ patient_id: string; start_at: Date; service: string }>(
      `SELECT DISTINCT ON (a.patient_id) a.patient_id, a.start_at, s.name AS service FROM appointments a JOIN services s ON s.id = a.service_id
       WHERE a.client_id = $1 AND a.status IN ('requested', 'confirmed') AND a.start_at > $2 ORDER BY a.patient_id, a.start_at`,
      [input.clientId, new Date(input.now)],
    ),
    loadRetentionInput(db, input.locationId, today),
    db.query<{ id: string; pack_service_id: string; category: string }>(
      `SELECT id, pack_service_id, category FROM services WHERE location_id = $1 AND active AND bookable_online`,
      [input.locationId],
    ),
  ]);
  const name = client.rows[0]?.first_name;
  if (!name) throw new ValidationError("Your details could not be found. Please call us.");
  const online = new Map(services.rows.filter((s) => canBookOnline({ packServiceId: s.pack_service_id, category: s.category })).map((s) => [s.pack_service_id, s.id]));
  const rules = new Map(
    (getVeterinaryPack().retention as unknown as { rules: { id: string; name: string; books_service?: string | null }[] }).rules.map((r) => [r.id, r]),
  );
  const mine = new Set(pets.rows.map((p) => p.id));
  const due = new Map<string, WidgetPet["due"]>();
  for (const d of dueReminders({ ...retention, patients: retention.patients.filter((p) => mine.has(p.id)) }).sort((a, b) => a.dueIn - b.dueIn)) {
    if (d.suppressed || due.has(d.patientId)) continue;
    const rule = rules.get(d.ruleId);
    const packService = serviceForRule(rule);
    due.set(d.patientId, {
      label: d.detail ? `${d.ruleName} (${d.detail})` : d.ruleName,
      dueAt: d.dueAt,
      overdue: d.dueIn < 0,
      serviceId: packService ? (online.get(packService) ?? null) : null,
    });
  }
  const next = new Map(upcoming.rows.map((u) => [u.patient_id, { start: u.start_at, serviceName: u.service }]));
  return {
    firstName: name,
    pets: pets.rows.map((p) => {
      const months = ageInMonths({ dateOfBirth: p.dob, approxAgeMonths: p.approx }, today);
      return {
        id: p.id,
        name: p.name,
        species: p.species,
        ageText: months === null ? null : months < 12 ? `${months} mo` : `${Math.floor(months / 12)} yr`,
        due: due.get(p.id) ?? null,
        upcoming: next.get(p.id) ?? null,
      };
    }),
  };
}

// ---------- Visits a client may book ----------

export interface WidgetService {
  id: string;
  packServiceId: string;
  name: string;
  durationMin: number;
  priceLow: number | null;
  priceHigh: number | null;
}

/** Routine visits the clinic lets clients book online for this species. */
export async function widgetServices(db: SqlClient, input: { locationId: string; species: string; newPatient: boolean }): Promise<WidgetService[]> {
  const { rows } = await db.query<{ id: string; pack_service_id: string; name: string; category: string; duration_min: number; low: string | null; high: string | null }>(
    `SELECT s.id, s.pack_service_id, s.name, s.category, s.duration_min, s.price_low_usd AS low, s.price_high_usd AS high
     FROM services s JOIN service_species sp ON sp.service_id = s.id
     WHERE s.location_id = $1 AND s.active AND s.bookable_online AND sp.species = $2
     ORDER BY CASE s.category WHEN 'exam' THEN 0 WHEN 'tech' THEN 1 ELSE 2 END, s.name`,
    [input.locationId, input.species],
  );
  return rows
    .filter((s) => canBookOnline({ packServiceId: s.pack_service_id, category: s.category }))
    // A first visit is always the new-patient exam; existing pets never book it.
    .filter((s) => (input.newPatient ? s.pack_service_id === "wellness_exam_new" : s.pack_service_id !== "wellness_exam_new"))
    .map((s) => ({ id: s.id, packServiceId: s.pack_service_id, name: s.name, durationMin: s.duration_min, priceLow: s.low === null ? null : Number(s.low), priceHigh: s.high === null ? null : Number(s.high) }));
}

/**
 * The visits this pet can book online today: the clinic's online list, less
 * anything the booking rules would stop (age, species, prerequisites), so the
 * client never picks a visit that is then refused.
 */
export async function widgetServicesForPet(
  db: SqlClient,
  input: { locationId: string; clientId: string; patientId: string; timezone: string; now: number },
): Promise<WidgetService[] | null> {
  const { rows } = await db.query<{ species: string; first_visit: boolean }>(
    `SELECT p.species, p.provisional AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = p.id AND a.status = 'completed') AS first_visit
     FROM patients p WHERE p.id = $1 AND p.client_id = $2 AND p.location_id = $3 AND p.status = 'active'`,
    [input.patientId, input.clientId, input.locationId],
  );
  const pet = rows[0];
  if (!pet) return null;
  const today = localParts(input.now, input.timezone).date;
  const list = await widgetServices(db, { locationId: input.locationId, species: pet.species, newPatient: pet.first_visit });
  const [patient, ...rules] = await Promise.all([
    loadPatientForBooking(db, input.locationId, input.patientId),
    ...list.map((s) => loadService(db, input.locationId, s.id)),
  ]);
  return list.filter((_, i) => {
    const e = checkEligibility(rules[i]!, patient, today);
    return e.blocking.length === 0 && e.warnings.length === 0;
  });
}

/** Species the clinic's online visits cover (for the new-client form). */
export async function widgetSpecies(db: SqlClient, locationId: string): Promise<string[]> {
  const { rows } = await db.query<{ species: string }>(
    `SELECT DISTINCT sp.species FROM services s JOIN service_species sp ON sp.service_id = s.id
     WHERE s.location_id = $1 AND s.active AND s.bookable_online AND s.pack_service_id = 'wellness_exam_new' ORDER BY sp.species`,
    [locationId],
  );
  return rows.map((r) => r.species);
}

/** The session's own pet, or an error. Every booking step checks this. */
async function ownPet(db: SqlClient, session: WidgetSession, locationId: string, patientId: string): Promise<{ species: string; firstVisit: boolean }> {
  if (!session.clientId) throw new ValidationError("Please add your details first.");
  const { rows } = await db.query<{ species: string; first_visit: boolean }>(
    `SELECT p.species, NOT EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = p.id AND a.status = 'completed') AND p.provisional AS first_visit
     FROM patients p WHERE p.id = $1 AND p.client_id = $2 AND p.location_id = $3 AND p.status = 'active'`,
    [patientId, session.clientId, locationId],
  );
  if (!rows[0]) throw new ValidationError("That pet could not be found. Please call us.");
  return { species: rows[0].species, firstVisit: rows[0].first_visit };
}

async function allowedService(db: SqlClient, session: WidgetSession, locationId: string, patientId: string, serviceId: string): Promise<boolean> {
  const pet = await ownPet(db, session, locationId, patientId);
  const list = await widgetServices(db, { locationId, species: pet.species, newPatient: pet.firstVisit });
  return list.some((s) => s.id === serviceId);
}

export async function widgetTimes(
  db: SqlClient,
  input: { locationId: string; timezone: string; session: WidgetSession; patientId: string; serviceId: string; now: number },
): Promise<OnlineTimesResult> {
  if (!(await allowedService(db, input.session, input.locationId, input.patientId, input.serviceId))) {
    return { status: "blocked", message: "This visit can't be booked online. Please call us." };
  }
  return onlineTimes(db, input);
}

/** Books from the widget. Call inside a transaction. */
export async function widgetBook(
  db: SqlClient,
  input: { locationId: string; clinicName: string; timezone: string; session: WidgetSession; patientId: string; serviceId: string; start: number; providerId: string; now: number; sandbox: boolean },
): Promise<OnlineBookResult> {
  if (!(await allowedService(db, input.session, input.locationId, input.patientId, input.serviceId))) {
    return { status: "blocked", message: "This visit can't be booked online. Please call us." };
  }
  return bookOnline(db, { ...input, clientId: input.session.clientId!, via: "widget" });
}

// ---------- New clients ----------

/**
 * A new client and their first pet, for a verified number not on file. The
 * pet is provisional until staff check the details at the first visit.
 * Call inside a transaction.
 */
export async function widgetRegister(
  db: SqlClient,
  input: { locationId: string; timezone: string; session: WidgetSession; form: NewClientForm; now: number },
): Promise<{ clientId: string; patientId: string }> {
  if (input.session.clientId) throw new ValidationError("You're already on file with us.");
  const species = await widgetSpecies(db, input.locationId);
  if (!species.includes(input.form.species)) throw new ValidationError("We can't book this kind of pet online. Please call us.", { field: "species" });
  const today = localParts(input.now, input.timezone).date;
  const { client, patient } = validateNewClient(input.form, input.session.mobile, today);
  const clientId = await createClient(db, { locationId: input.locationId, client, source: "web", actor: { type: "client", id: null } });
  const patientId = await createPatient(db, { locationId: input.locationId, clientId, patient, actor: { type: "client", id: clientId }, provisional: true });
  await db.query(`UPDATE widget_sessions SET client_id = $2 WHERE id = $1`, [input.session.id, clientId]);
  input.session.clientId = clientId;
  return { clientId, patientId };
}

/** Adds another pet for a client already on file (provisional until the visit). Call inside a transaction. */
export async function widgetAddPet(
  db: SqlClient,
  input: { locationId: string; timezone: string; session: WidgetSession; pet: Pick<NewClientForm, "petName" | "species" | "ageBand" | "sex">; now: number },
): Promise<string> {
  if (!input.session.clientId) throw new ValidationError("Please add your details first.");
  const species = await widgetSpecies(db, input.locationId);
  if (!species.includes(input.pet.species)) throw new ValidationError("We can't book this kind of pet online. Please call us.", { field: "species" });
  const today = localParts(input.now, input.timezone).date;
  const { patient } = validateNewClient({ firstName: "x", lastName: "x", smsConsent: false, ...input.pet }, input.session.mobile, today);
  const id = await createPatient(db, { locationId: input.locationId, clientId: input.session.clientId, patient, actor: { type: "client", id: input.session.clientId }, provisional: true });
  return id;
}

// ---------- Settings ----------

export async function saveWidgetSettings(
  db: SqlClient,
  ctx: { locationId: string; actor: Actor },
  v: { enabled: boolean; origins: string[] },
): Promise<void> {
  const before = await db.query<{ widget_enabled: boolean; widget_origins: string[] }>(`SELECT widget_enabled, widget_origins FROM locations WHERE id = $1`, [ctx.locationId]);
  await db.query(`UPDATE locations SET widget_enabled = $2, widget_origins = $3 WHERE id = $1`, [ctx.locationId, v.enabled, v.origins]);
  const b = before.rows[0];
  if (b && (b.widget_enabled !== v.enabled || b.widget_origins.join(",") !== v.origins.join(","))) {
    await writeAudit(db, {
      locationId: ctx.locationId,
      actor: ctx.actor,
      action: "settings.widget",
      entityType: "location",
      entityId: ctx.locationId,
      changes: { enabled: [b.widget_enabled, v.enabled], origins: [b.widget_origins, v.origins] },
    });
  }
}

export async function setServiceBookableOnline(
  db: SqlClient,
  ctx: { locationId: string; actor: Actor },
  serviceId: string,
  bookable: boolean,
): Promise<void> {
  const { rows } = await db.query<{ pack_service_id: string; category: string; bookable_online: boolean }>(
    `SELECT pack_service_id, category, bookable_online FROM services WHERE id = $1 AND location_id = $2`,
    [serviceId, ctx.locationId],
  );
  const s = rows[0];
  if (!s) throw new ValidationError("That service could not be found.");
  if (bookable && !canBookOnline({ packServiceId: s.pack_service_id, category: s.category })) {
    throw new ValidationError("This visit needs the team or Riley to book it (triage, deposits or a staff decision).");
  }
  if (s.bookable_online === bookable) return;
  await db.query(`UPDATE services SET bookable_online = $3 WHERE id = $1 AND location_id = $2`, [serviceId, ctx.locationId, bookable]);
  await writeAudit(db, { locationId: ctx.locationId, actor: ctx.actor, action: "settings.service_online", entityType: "service", entityId: serviceId, changes: { bookable_online: [!bookable, bookable] } });
}

/** Removes used and old codes and sessions (run daily). */
export async function pruneWidget(db: SqlClient, now: number): Promise<void> {
  const day = new Date(now - 86_400_000);
  await db.query(`DELETE FROM widget_verifications WHERE created_at < $1`, [day]);
  await db.query(`DELETE FROM widget_sessions WHERE expires_at < $1`, [day]);
}
