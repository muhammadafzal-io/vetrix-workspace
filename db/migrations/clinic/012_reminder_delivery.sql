-- Overdue vaccine reminders (Feature 3): a pause switch for each location's
-- reminders, retries for messages that failed to send, and delivery reports.
-- Columns only: the clinic schema stays at 64 tables. Each clinic's reminder
-- schedule is stored in the existing reminder_rules.overrides column.

-- Set while a location's reminders are paused (who paused is in the audit log).
ALTER TABLE location_messaging_settings
  ADD COLUMN reminders_paused_at timestamptz;

-- attempts: how many times sending was tried. next_attempt_at: when a failed
-- send is tried again (queued messages wait until then). delivered_at: when
-- the carrier reported the text delivered (Twilio status callback).
ALTER TABLE messages
  ADD COLUMN attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN delivered_at timestamptz;

-- Messages already handed to a provider were tried once.
UPDATE messages SET attempts = 1 WHERE status IN ('sent', 'delivered', 'failed');

-- The scheduler reads queued messages that are ready to send.
CREATE INDEX messages_queued_ready_idx ON messages (location_id, next_attempt_at) WHERE status = 'queued';
