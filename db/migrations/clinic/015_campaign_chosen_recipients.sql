-- Staff may send a campaign to only some of the clients who match its rules
-- (decided 25 Nov 2026). NULL = everyone who matches (as before); a list =
-- only these clients, and only while they still match when sending starts.
-- Consent, do-not-contact and the 7-day limit are still checked per message.
-- Columns only: the clinic schema stays at 67 tables. IF NOT EXISTS: the dev
-- database already had this exact column, added by hand before this file.

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS recipient_ids uuid[];
