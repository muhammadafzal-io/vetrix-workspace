-- A campaign is marketing (as before) or a clinic announcement: service news
-- such as a closure or new hours (decided 25 Nov 2026). Announcements need no
-- marketing consent, skip the 7-day marketing limit (and do not count toward
-- it) and carry no unsubscribe link; their copy may not promote anything.
-- Columns only: the clinic schema stays at 67 tables.

ALTER TABLE campaigns
  ADD COLUMN kind text NOT NULL DEFAULT 'marketing' CHECK (kind IN ('marketing', 'announcement'));
