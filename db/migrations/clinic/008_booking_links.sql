-- Milestone 4: online booking links.
-- Each reminder text or email carries its own short link. The link knows the
-- client and, for each pet it covers, which visit to book, so the client only
-- picks a time. The token is long and random; the page needs no sign-in.

CREATE TABLE booking_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  source text NOT NULL CHECK (source IN ('reminder', 'staff')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  opened_at timestamptz
);
CREATE INDEX booking_links_client_id_idx ON booking_links (client_id);

CREATE TABLE booking_link_items (
  link_id uuid NOT NULL REFERENCES booking_links(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  -- Null when the clinic does not offer the visit: the page asks them to call.
  service_id uuid REFERENCES services(id),
  appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,
  PRIMARY KEY (link_id, patient_id)
);
