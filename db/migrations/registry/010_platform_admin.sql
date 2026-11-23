-- Platform administration: who may add clinics, and what is needed to set up
-- a clinic database from the app (Neon project, retry after a failed step).
-- No new tables: the registry still has 13.

-- People who run the platform (not clinic staff). Granted only from the
-- command line: pnpm db:admin:grant --email you@example.com
ALTER TABLE platform_users
  ADD COLUMN is_platform_admin boolean NOT NULL DEFAULT false;

ALTER TABLE tenant_databases
  -- The Neon project that holds this clinic database (null for databases added by hand).
  ADD COLUMN neon_project_id text,
  -- What the platform admin entered (first location, time zone, owner), kept
  -- so a failed setup can be retried. Never holds a password or connection string.
  ADD COLUMN setup_request jsonb,
  -- Set while a setup runs, so two retries cannot run at the same time.
  ADD COLUMN setup_started_at timestamptz,
  -- Why the last setup step failed, shown on the Clinics page; cleared on success.
  ADD COLUMN last_error text,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
