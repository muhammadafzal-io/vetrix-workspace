// Online booking links: created with reminder messages, opened by clients on
// a public page, used to book the visit the reminder was about.
// The token is the only key (96 random bits); the page shows the clinic, the
// client's first name and their pets' names, nothing more.
import { randomBytes, randomUUID } from "node:crypto";
import {
  checkEligibility,
  ConflictError,
  findSlots,
  RuleViolationError,
  dateRange,
  fillScript,
  localParts,
  ONLINE_BOOKING,
  SCRIPTS,
  serviceForRule,
  spreadByDay,
  type PlannedTouch,
} from "@vetrix/domain";
import { getVeterinaryPack } from "@vetrix/pack";
import { bookAppointment, loadPatientForBooking, loadSchedulingData, loadService } from "./booking";
import { writeAudit } from "./clients";
import type { SqlClient } from "./sql-client";

export function newBookingToken(): string {
  return randomBytes(12).toString("base64url"); // 16 characters
}

// ---------- Creating links with reminders ----------

export interface PendingLink {
  token: string;
  clientId: string;
  touches: PlannedTouch[];
}

/**
 * Saves the links that made it into saved messages (a message held for quiet
 * hours is not saved, and neither is its link). Each pet gets the visit its
 * reminder books; a pet in two reminders gets the first one's visit.
 */
export async function saveReminderLinks(
  db: SqlClient,
  input: { locationId: string; now: number; messages: { id: string; body: string }[]; pending: Map<string, PendingLink> },
): Promise<number> {
  const links: { id: string; token: string; clientId: string; messageId: string; touches: PlannedTouch[] }[] = [];
  for (const m of input.messages) {
    for (const [token, p] of input.pending) {
      if (m.body.includes(token)) links.push({ id: randomUUID(), token, clientId: p.clientId, messageId: m.id, touches: p.touches });
    }
  }
  if (links.length === 0) return 0;

  const rules = new Map(
    (getVeterinaryPack().retention as unknown as { rules: { id: string; books_service?: string | null }[] }).rules.map((r) => [r.id, serviceForRule(r)]),
  );
  const services = new Map(
    (await db.query<{ id: string; pack_service_id: string }>(`SELECT id, pack_service_id FROM services WHERE location_id = $1 AND active`, [input.locationId])).rows.map(
      (s) => [s.pack_service_id, s.id],
    ),
  );
  // No-show recovery rebooks the visit that was missed.
  const missedPets = [...new Set(links.flatMap((l) => l.touches.filter((t) => rules.get(t.ruleId) === "same_as_missed_appointment").map((t) => t.patientId)))];
  const missed = new Map<string, string>();
  if (missedPets.length) {
    const { rows } = await db.query<{ patient_id: string; service_id: string }>(
      `SELECT DISTINCT ON (a.patient_id) a.patient_id, a.service_id FROM appointments a JOIN services s ON s.id = a.service_id
       WHERE a.location_id = $1 AND a.status = 'no_show' AND s.active AND a.patient_id = ANY($2::uuid[]) ORDER BY a.patient_id, a.start_at DESC`,
      [input.locationId, missedPets],
    );
    for (const r of rows) missed.set(r.patient_id, r.service_id);
  }
  const serviceOf = (t: PlannedTouch): string | null => {
    const packId = rules.get(t.ruleId);
    if (packId === "same_as_missed_appointment") return missed.get(t.patientId) ?? null;
    return packId ? (services.get(packId) ?? null) : null;
  };

  const expires = new Date(input.now + ONLINE_BOOKING.expiresDays * 86_400_000);
  await db.query(
    `INSERT INTO booking_links (id, location_id, token, client_id, message_id, source, expires_at)
     SELECT u.id, $1, u.token, u.client_id, u.message_id, 'reminder', $2 FROM unnest($3::uuid[], $4::text[], $5::uuid[], $6::uuid[]) AS u(id, token, client_id, message_id)`,
    [input.locationId, expires, links.map((l) => l.id), links.map((l) => l.token), links.map((l) => l.clientId), links.map((l) => l.messageId)],
  );
  const items = links.flatMap((l) => {
    const perPet = new Map<string, string | null>();
    for (const t of l.touches) if (!perPet.has(t.patientId) || perPet.get(t.patientId) === null) perPet.set(t.patientId, serviceOf(t));
    return [...perPet].map(([patientId, serviceId]) => ({ linkId: l.id, patientId, serviceId }));
  });
  await db.query(
    `INSERT INTO booking_link_items (link_id, patient_id, service_id) SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[])`,
    [items.map((i) => i.linkId), items.map((i) => i.patientId), items.map((i) => i.serviceId)],
  );
  return links.length;
}

// ---------- The public page ----------

export interface BookingLinkPet {
  patientId: string;
  name: string;
  serviceId: string | null;
  serviceName: string | null;
  /** Booked through this link, or already on the schedule for this visit. */
  booked: { start: Date; serviceName: string } | null;
  /** Why it cannot be booked online (call instead). */
  unavailable: string | null;
}

export interface BookingLinkView {
  clinicName: string;
  clinicPhone: string | null;
  timezone: string;
  firstName: string;
  expired: boolean;
  pets: BookingLinkPet[];
}

async function linkRow(db: SqlClient, token: string) {
  const { rows } = await db.query<{
    id: string; location_id: string; client_id: string; expires_at: Date; first_name: string; clinic: string; main_phone: string | null; timezone: string;
  }>(
    `SELECT bl.id, bl.location_id, bl.client_id, bl.expires_at, c.first_name, l.name AS clinic, l.main_phone, l.timezone
     FROM booking_links bl JOIN clients c ON c.id = bl.client_id JOIN locations l ON l.id = bl.location_id WHERE bl.token = $1`,
    [token],
  );
  return rows[0] ?? null;
}

export async function loadBookingLink(db: SqlClient, token: string, now: number): Promise<BookingLinkView | null> {
  const link = await linkRow(db, token);
  if (!link) return null;
  await db.query(`UPDATE booking_links SET opened_at = coalesce(opened_at, now()) WHERE id = $1`, [link.id]);
  const { rows } = await db.query<{
    patient_id: string; name: string; status: string; service_id: string | null; service_name: string | null; bookable: boolean | null;
    booked_start: Date | null; booked_service: string | null;
  }>(
    `SELECT i.patient_id, p.name, p.status, i.service_id, s.name AS service_name, s.active AS bookable,
            b.start_at AS booked_start, b.service_name AS booked_service
     FROM booking_link_items i JOIN patients p ON p.id = i.patient_id LEFT JOIN services s ON s.id = i.service_id
     LEFT JOIN LATERAL (
       SELECT a.start_at, s2.name AS service_name FROM appointments a JOIN services s2 ON s2.id = a.service_id
       WHERE a.patient_id = i.patient_id AND a.status IN ('requested', 'confirmed') AND a.start_at > $2
         AND (a.id = i.appointment_id OR a.service_id = i.service_id)
       ORDER BY a.start_at LIMIT 1
     ) b ON true
     WHERE i.link_id = $1 ORDER BY p.name`,
    [link.id, new Date(now)],
  );
  return {
    clinicName: link.clinic,
    clinicPhone: link.main_phone,
    timezone: link.timezone,
    firstName: link.first_name,
    expired: link.expires_at.getTime() < now,
    pets: rows.map((r) => ({
      patientId: r.patient_id,
      name: r.name,
      serviceId: r.service_id,
      serviceName: r.service_name,
      booked: r.booked_start ? { start: r.booked_start, serviceName: r.booked_service! } : null,
      unavailable:
        r.status !== "active" ? "not_active" : !r.service_id || !r.bookable ? "Please call us to book this visit." : null,
    })),
  };
}

export interface LinkTime {
  start: number;
  providerId: string;
  providerName: string;
}

export type LinkTimesResult =
  | { status: "ok"; days: { date: string; times: LinkTime[] }[] }
  | { status: "blocked"; message: string }
  | { status: "invalid" | "expired" | "booked" };

async function linkItem(db: SqlClient, token: string, patientId: string, now: number, lock = false) {
  const link = await linkRow(db, token);
  if (!link) return { ok: false as const, error: "invalid" as const };
  if (link.expires_at.getTime() < now) return { ok: false as const, error: "expired" as const };
  const { rows } = await db.query<{ service_id: string | null; appointment_id: string | null }>(
    `SELECT service_id, appointment_id FROM booking_link_items WHERE link_id = $1 AND patient_id = $2${lock ? " FOR UPDATE" : ""}`,
    [link.id, patientId],
  );
  const item = rows[0];
  if (!item) return { ok: false as const, error: "invalid" as const };
  return { ok: true as const, link, item };
}

export type OnlineTimesResult = { status: "ok"; days: { date: string; times: LinkTime[] }[] } | { status: "blocked"; message: string } | { status: "invalid" };

const NEEDS_CHECK = "This visit needs a quick check by our team first. Please call us to book.";

/**
 * Free times for one pet's visit, a spread per day over the next three weeks.
 * Shared by reminder links and the booking widget. Strict, as for the AI front
 * desk: anything that needs a staff decision is booked by phone.
 */
export async function onlineTimes(
  db: SqlClient,
  input: { locationId: string; timezone: string; serviceId: string; patientId: string; now: number },
): Promise<OnlineTimesResult> {
  const today = localParts(input.now, input.timezone).date;
  const [service, patient, data] = await Promise.all([
    loadService(db, input.locationId, input.serviceId),
    loadPatientForBooking(db, input.locationId, input.patientId),
    loadSchedulingData(db, input.locationId, today, ONLINE_BOOKING.searchDays),
  ]);
  if (patient.status !== "active") return { status: "invalid" };
  const e = checkEligibility(service, patient, today);
  if (e.blocking.length || e.warnings.length) return { status: "blocked", message: NEEDS_CHECK };
  const slots = findSlots(data, {
    service,
    patient,
    dates: dateRange(today, ONLINE_BOOKING.searchDays),
    notBefore: input.now + ONLINE_BOOKING.leadMinutes * 60_000,
    limit: 600,
  });
  const names = new Map(data.providers.map((p) => [p.id, p.name]));
  return {
    status: "ok",
    days: spreadByDay(
      slots.map((s) => ({ start: s.start, providerId: s.providerId, providerName: names.get(s.providerId) ?? "" })),
      input.timezone,
    ),
  };
}

/** Free times for one pet's visit from a reminder link. */
export async function bookingLinkTimes(db: SqlClient, input: { token: string; patientId: string; now: number }): Promise<LinkTimesResult> {
  const found = await linkItem(db, input.token, input.patientId, input.now);
  if (!found.ok) return { status: found.error };
  const { link, item } = found;
  if (!item.service_id) return { status: "blocked", message: "Please call us to book this visit." };
  return onlineTimes(db, { locationId: link.location_id, timezone: link.timezone, serviceId: item.service_id, patientId: input.patientId, now: input.now });
}

export type OnlineBookResult =
  | { status: "booked"; petName: string; serviceName: string; start: Date; providerName: string; timezone: string; confirmation: "sms" | "email" | null; appointmentId: string }
  | { status: "taken" | "already_booked" | "blocked"; message?: string };

export type LinkBookResult = OnlineBookResult | { status: "invalid" | "expired"; message?: string };

const when = (start: number, tz: string) => {
  const date = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz }).format(start);
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(start);
  return { date, time };
};

/**
 * A client books a time themselves (reminder link or widget): strict rules,
 * a confirmation (text, else email) and an audit entry. Call inside a transaction.
 */
export async function bookOnline(
  db: SqlClient,
  input: {
    locationId: string;
    clinicName: string;
    timezone: string;
    clientId: string;
    patientId: string;
    serviceId: string;
    start: number;
    providerId: string;
    now: number;
    sandbox: boolean;
    /** The appointment this link already booked, if any. */
    linkedAppointmentId?: string | null;
    via: "link" | "widget";
  },
): Promise<OnlineBookResult> {
  const already = await db.query(
    `SELECT 1 FROM appointments WHERE patient_id = $1 AND status IN ('requested', 'confirmed') AND start_at > $2 AND (id = $3 OR service_id = $4)`,
    [input.patientId, new Date(input.now), input.linkedAppointmentId ?? null, input.serviceId],
  );
  if (already.rows[0]) return { status: "already_booked" };
  if (input.start < input.now + ONLINE_BOOKING.leadMinutes * 60_000) return { status: "taken" };

  const today = localParts(input.now, input.timezone).date;
  let booked;
  try {
    booked = await bookAppointment(db, {
      locationId: input.locationId,
      patientId: input.patientId,
      serviceId: input.serviceId,
      start: input.start,
      providerId: input.providerId,
      bookedBy: "web",
      actor: { type: "client", id: input.clientId },
      today,
      strict: true,
    });
  } catch (error) {
    if (error instanceof ConflictError) return { status: "taken" };
    if (error instanceof RuleViolationError) return { status: "blocked", message: NEEDS_CHECK };
    throw error;
  }

  const { rows } = await db.query<{ pet: string; service: string; provider: string; sms_consent: boolean; email: string | null; dnc: boolean }>(
    `SELECT p.name AS pet, s.name AS service, pr.display_name AS provider, c.sms_consent, c.email,
            EXISTS (SELECT 1 FROM client_flags f WHERE f.client_id = c.id AND f.flag = 'do_not_contact') AS dnc
     FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN services s ON s.id = a.service_id
     JOIN providers pr ON pr.id = a.provider_id JOIN clients c ON c.id = a.client_id WHERE a.id = $1`,
    [booked.appointmentId],
  );
  const a = rows[0]!;
  const w = when(booked.slot.start, input.timezone);
  const line = `${a.pet} is booked for ${a.service.toLowerCase()} on ${w.date} at ${w.time}`;
  const confirmation: "sms" | "email" | null = a.dnc ? null : a.sms_consent ? "sms" : a.email ? "email" : null;
  if (confirmation) {
    await db.query(
      `INSERT INTO messages (location_id, client_id, patient_id, appointment_id, channel, template_key, subject, body, status, sent_at)
       VALUES ($1, $2, $3, $4, $5, 'appointment_confirmation', $6, $7, $8, $9)`,
      [input.locationId, input.clientId, input.patientId, booked.appointmentId, confirmation,
       confirmation === "email" ? `${a.pet}'s appointment at ${input.clinicName}` : null,
       fillScript(SCRIPTS.confirmationSms, { clinic_name: input.clinicName, visits: line }),
       input.sandbox ? "simulated" : "queued", input.sandbox ? new Date() : null],
    );
  }
  await writeAudit(db, {
    locationId: input.locationId,
    actor: { type: "client", id: input.clientId },
    action: "appointment.booked_online",
    entityType: "appointment",
    entityId: booked.appointmentId,
    changes: { via: input.via },
  });
  return {
    status: "booked",
    petName: a.pet,
    serviceName: a.service,
    start: new Date(booked.slot.start),
    providerName: a.provider,
    timezone: input.timezone,
    confirmation,
    appointmentId: booked.appointmentId,
  };
}

/** Books the chosen time from a reminder link. Call inside a transaction. */
export async function bookFromLink(
  db: SqlClient,
  input: { token: string; patientId: string; start: number; providerId: string; now: number; sandbox: boolean },
): Promise<LinkBookResult> {
  const found = await linkItem(db, input.token, input.patientId, input.now, true);
  if (!found.ok) return { status: found.error };
  const { link, item } = found;
  if (!item.service_id) return { status: "blocked", message: "Please call us to book this visit." };
  const r = await bookOnline(db, {
    locationId: link.location_id,
    clinicName: link.clinic,
    timezone: link.timezone,
    clientId: link.client_id,
    patientId: input.patientId,
    serviceId: item.service_id,
    start: input.start,
    providerId: input.providerId,
    now: input.now,
    sandbox: input.sandbox,
    linkedAppointmentId: item.appointment_id,
    via: "link",
  });
  if (r.status === "booked") {
    await db.query(`UPDATE booking_link_items SET appointment_id = $3 WHERE link_id = $1 AND patient_id = $2`, [link.id, input.patientId, r.appointmentId]);
  }
  return r;
}

/** The location and clinic name behind a link (for sending its messages). */
export function linkLocationId(db: SqlClient, token: string): Promise<{ location_id: string; clinic: string } | null> {
  return linkRow(db, token).then((l) => (l ? { location_id: l.location_id, clinic: l.clinic } : null));
}
