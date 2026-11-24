-- A campaign's audience is fixed when it starts sending (decided 24 Nov 2026).
-- At the start every matching client and channel gets a 'pending' row; later
-- runs only work through those rows, so clients who match afterwards are not
-- added. Consent, do-not-contact, the 7-day limit and the pets being active
-- are still checked when each message goes out. Columns only: 67 tables.

ALTER TABLE campaigns
  ADD COLUMN audience_fixed_at timestamptz;

-- Rows already written were sent or skipped; their audience was fixed then.
UPDATE campaigns SET audience_fixed_at = coalesce(started_at, now()) WHERE status = 'sent';

ALTER TABLE campaign_recipients
  ADD COLUMN pet_ids uuid[] NOT NULL DEFAULT '{}';

ALTER TABLE campaign_recipients DROP CONSTRAINT campaign_recipients_status_check;
ALTER TABLE campaign_recipients ADD CONSTRAINT campaign_recipients_status_check CHECK (status IN ('pending', 'sent', 'skipped'));

-- The scheduler reads the waiting rows of a campaign.
CREATE INDEX campaign_recipients_pending_idx ON campaign_recipients (campaign_id) WHERE status = 'pending';
