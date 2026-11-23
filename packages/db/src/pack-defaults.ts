// What every clinic location starts with from its pack: the service
// catalogue, the reminder rules and the vaccine types. Used by new clinics
// (clinic-setup.ts) and by the sample clinic (seed/sample-clinic.ts), so both
// always start from the same defaults. Run inside a transaction.
import { ONLINE_DEFAULT_SERVICES } from "@vetrix/domain";
import { isTaskService, type Pack } from "@vetrix/pack";
import type { SqlClient } from "./sql-client";

/** Returns pack service id -> { services.id, duration }. */
export async function installPackDefaults(
  client: SqlClient,
  pack: Pack,
  locationId: string,
): Promise<Map<string, { id: string; duration: number }>> {
  const q = (sql: string, params: unknown[]) => client.query(sql, params);
  // Services switched on by a setting start off (telehealth is off by default).
  const settings: Record<string, boolean> = { telehealth_enabled: false };
  const serviceIds = new Map<string, { id: string; duration: number }>();
  for (const s of pack.services.services) {
    if (isTaskService(s)) continue; // task-only entries such as refills are not booked
    const setting = (s as { enabled_by_setting?: string }).enabled_by_setting;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO services (location_id, pack_service_id, name, category, duration_min, buffer_before_min, buffer_after_min,
         provider_role, room_type, requires_doctor_on_premises, drop_off, drop_off_window, fasting_required,
         requires_preop_bloodwork, prerequisites, price_low_usd, price_high_usd, bookable_by_ai, active, bookable_online)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
      [
        locationId, s.id, s.name, s.category, s.duration_min, s.buffer_before_min ?? 0, s.buffer_after_min,
        s.provider_role, s.room_type, s.requires_doctor_on_premises, s.drop_off, s.drop_off_window ?? null,
        s.fasting_required, s.requires_preop_bloodwork, JSON.stringify(s.prerequisites),
        s.price_range_usd[0], s.price_range_usd[1], s.bookable_by_ai, setting ? (settings[setting] ?? false) : true, ONLINE_DEFAULT_SERVICES.has(s.id),
      ],
    );
    const id = rows[0]!.id;
    serviceIds.set(s.id, { id, duration: s.duration_min });
    for (const sp of s.species) await q(`INSERT INTO service_species VALUES ($1, $2)`, [id, sp]);
    for (const k of s.required_skills) await q(`INSERT INTO service_skills VALUES ($1, $2)`, [id, k]);
    for (const e of s.equipment) await q(`INSERT INTO service_equipment (service_id, equipment_type) VALUES ($1, $2)`, [id, e]);
  }
  for (const r of pack.retention.rules) {
    await q(`INSERT INTO reminder_rules (location_id, pack_rule_id) VALUES ($1, $2)`, [locationId, r.id]);
  }
  for (const v of pack.retention.vaccines) {
    await q(
      `INSERT INTO vaccine_types (id, name, species, default_interval_months, core) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [v.id, v.name, v.species.join(","), v.default_interval_months, v.core],
    );
  }
  return serviceIds;
}
