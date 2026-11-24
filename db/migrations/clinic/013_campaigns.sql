-- AI campaigns (Feature 2): marketing texts and emails to an audience of
-- clients, written with AI, approved by staff, sent through `messages`.
-- 3 new tables: the clinic schema goes from 64 to 67 tables.

-- One campaign at one location. `audience` holds the rules (match all / any
-- of a few conditions, checked by @vetrix/domain); the people it reached are
-- in campaign_recipients. Status: draft → approved → scheduled → sending →
-- sent, or cancelled before sending finishes.
CREATE TABLE campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  goal text NOT NULL CHECK (char_length(goal) BETWEEN 1 AND 1000),
  audience jsonb NOT NULL DEFAULT '{"match": "all", "conditions": []}'::jsonb,
  channels text[] NOT NULL CHECK (cardinality(channels) > 0 AND channels <@ ARRAY['sms', 'email']::text[]),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'scheduled', 'sending', 'sent', 'cancelled')),
  send_at timestamptz,
  created_by uuid REFERENCES staff_users(id),
  approved_by uuid REFERENCES staff_users(id),
  approved_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campaigns_location_id_created_at_idx ON campaigns (location_id, created_at DESC);
-- The scheduler looks only at campaigns waiting to go out.
CREATE INDEX campaigns_due_idx ON campaigns (location_id, send_at) WHERE status IN ('scheduled', 'sending');

-- Every version of a campaign's text and email: AI drafts and staff edits are
-- kept apart (source), and exactly one version per channel is approved.
-- The approved version is what goes out; it is never edited afterwards.
CREATE TABLE campaign_content (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('sms', 'email')),
  version int NOT NULL CHECK (version > 0),
  source text NOT NULL CHECK (source IN ('ai', 'staff')),
  subject text CHECK (subject IS NULL OR char_length(subject) <= 150),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  approved boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES staff_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, channel, version)
);
CREATE UNIQUE INDEX campaign_content_approved_key ON campaign_content (campaign_id, channel) WHERE approved;

-- Who the campaign reached on each channel, or why not (skip_reason). One row
-- per client and channel, so nobody gets the same campaign twice. Emails carry
-- an unsubscribe link; only the token's SHA-256 is stored.
CREATE TABLE campaign_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('sms', 'email')),
  status text NOT NULL CHECK (status IN ('sent', 'skipped')),
  skip_reason text,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  pet_names text,
  unsubscribe_token_hash text UNIQUE,
  unsubscribed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, client_id, channel),
  CHECK ((status = 'skipped') = (skip_reason IS NOT NULL))
);
-- "Contacted by a campaign in the last 7 days" and a client's campaign history.
CREATE INDEX campaign_recipients_client_id_created_at_idx ON campaign_recipients (client_id, created_at DESC);
CREATE INDEX campaign_recipients_message_id_idx ON campaign_recipients (message_id);

