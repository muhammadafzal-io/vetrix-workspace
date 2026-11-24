-- Patient history (front desk, not a clinical record): a weight history per
-- pet, filled when staff complete a visit or edit the pet. patients.weight_kg
-- stays as the latest value so everything that reads it keeps working.
-- Clinic databases only. Run after 009_widget.

CREATE TABLE patient_weights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  -- The visit it was measured at; empty for a staff edit or an import.
  appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,
  weight_kg numeric(6, 2) NOT NULL CHECK (weight_kg > 0 AND weight_kg <= 1000),
  measured_on date NOT NULL,
  source text NOT NULL CHECK (source IN ('visit', 'staff', 'import')),
  recorded_by uuid REFERENCES staff_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX patient_weights_patient_id_measured_on_idx ON patient_weights (patient_id, measured_on DESC);
-- One weight per visit: completing the same visit twice cannot add a second.
CREATE UNIQUE INDEX patient_weights_appointment_id_key ON patient_weights (appointment_id) WHERE appointment_id IS NOT NULL;

-- Today's single weight becomes each pet's first history row.
INSERT INTO patient_weights (patient_id, weight_kg, measured_on, source)
SELECT id, weight_kg, created_at::date, 'import' FROM patients WHERE weight_kg IS NOT NULL;
