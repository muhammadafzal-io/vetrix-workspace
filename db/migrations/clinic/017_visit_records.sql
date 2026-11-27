-- Visit records (approved 26 Nov 2026, a change to the V1 scope): notes,
-- recommendations, prescriptions and photos staff add to one visit. These
-- are clinical records, so:
--   * nothing is hard-deleted: "remove" voids a row with a reason;
--   * the pet and visit cannot be deleted while records point at them
--     (ON DELETE RESTRICT);
--   * every add, edit and void is in audit_logs (edits keep the old text);
--   * the AI front desk never reads these tables.
-- Photo files live in private object storage; only their keys are here.
-- Clinic databases only. Adds 3 tables (67 -> 70).

CREATE TABLE visit_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES locations(id),
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('note', 'recommendation')),
  body text NOT NULL CHECK (length(btrim(body)) > 0 AND length(body) <= 10000),
  -- "Recheck in 2 weeks": the date staff suggested, recommendations only.
  follow_up_on date CHECK (follow_up_on IS NULL OR kind = 'recommendation'),
  author_id uuid REFERENCES staff_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by uuid REFERENCES staff_users(id),
  void_reason text,
  CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX visit_entries_appointment_id_idx ON visit_entries (appointment_id, created_at);
CREATE INDEX visit_entries_patient_id_idx ON visit_entries (patient_id, created_at DESC);

CREATE TABLE visit_prescriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES locations(id),
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  drug_name text NOT NULL CHECK (length(btrim(drug_name)) > 0 AND length(drug_name) <= 200),
  strength text CHECK (length(strength) <= 100),
  dose text NOT NULL CHECK (length(btrim(dose)) > 0 AND length(dose) <= 200),
  route text CHECK (route IN ('oral', 'topical', 'injection', 'ophthalmic', 'otic', 'inhaled', 'other')),
  frequency text NOT NULL CHECK (length(btrim(frequency)) > 0 AND length(frequency) <= 200),
  duration_days integer CHECK (duration_days BETWEEN 1 AND 3650),
  quantity text CHECK (length(quantity) <= 100),
  refills integer NOT NULL DEFAULT 0 CHECK (refills BETWEEN 0 AND 12),
  instructions text CHECK (length(instructions) <= 2000),
  controlled boolean NOT NULL DEFAULT false,
  -- The doctor who prescribed it (a provider with role dvm, checked in code).
  prescribed_by uuid NOT NULL REFERENCES providers(id),
  recorded_by uuid REFERENCES staff_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by uuid REFERENCES staff_users(id),
  void_reason text,
  CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX visit_prescriptions_appointment_id_idx ON visit_prescriptions (appointment_id, created_at);
CREATE INDEX visit_prescriptions_patient_id_idx ON visit_prescriptions (patient_id, created_at DESC);

CREATE TABLE visit_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES locations(id),
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  storage_key text NOT NULL UNIQUE,
  thumb_key text NOT NULL UNIQUE,
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 10485760),
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  body_area text CHECK (length(body_area) <= 100),
  caption text CHECK (length(caption) <= 500),
  uploaded_by uuid REFERENCES staff_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by uuid REFERENCES staff_users(id),
  void_reason text,
  CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX visit_photos_appointment_id_idx ON visit_photos (appointment_id, created_at);
CREATE INDEX visit_photos_patient_id_idx ON visit_photos (patient_id, created_at DESC);
-- The same photo uploaded twice to one visit is stored once.
CREATE UNIQUE INDEX visit_photos_appointment_id_sha256_key ON visit_photos (appointment_id, sha256) WHERE voided_at IS NULL;
