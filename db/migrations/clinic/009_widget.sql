-- Public booking widget: a "Book a visit" button on the clinic's own website
-- (and a hosted page) where anyone can book, chat with the AI front desk or
-- call. Clients prove their mobile number with a texted code first.

-- Which visits clients may book themselves. Routine visits only by default;
-- sick visits go through the AI front desk so triage always runs.
ALTER TABLE services ADD COLUMN bookable_online boolean NOT NULL DEFAULT false;
UPDATE services SET bookable_online = true
WHERE pack_service_id IN (
  'wellness_exam_new', 'wellness_exam', 'senior_wellness', 'puppy_kitten_visit', 'recheck_exam',
  'vaccine_booster_tech', 'nail_trim', 'microchip', 'heartworm_test', 'weight_check', 'health_certificate'
);

-- The widget is off until the clinic turns it on. Origins are the websites
-- allowed to show it in a frame (e.g. https://happypawsvet.com).
ALTER TABLE locations
  ADD COLUMN widget_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN widget_origins text[] NOT NULL DEFAULT '{}';

-- Front desk conversations can now start in the widget's chat.
ALTER TABLE calls DROP CONSTRAINT calls_channel_check;
ALTER TABLE calls ADD CONSTRAINT calls_channel_check CHECK (channel IN ('voice', 'sms', 'web'));

-- Texted codes. Only a hash is kept; a code works once, for ten minutes,
-- and locks after five wrong tries.
CREATE TABLE widget_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  mobile text NOT NULL,
  code_hash text NOT NULL,
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  verified_at timestamptz
);
CREATE INDEX widget_verifications_mobile_idx ON widget_verifications (location_id, mobile, created_at DESC);

-- A verified visitor. The browser holds the token (not a cookie, so it works
-- inside another site's frame); only its hash is stored.
CREATE TABLE widget_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  mobile text NOT NULL,
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
