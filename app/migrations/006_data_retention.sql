-- Existing owners get a bounded grace period from migration, because past access
-- times were not recorded. Never infer an access time from a session expiry.
ALTER TABLE browsers ADD COLUMN last_active_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE browsers ADD COLUMN deletion_key_hash TEXT UNIQUE;
CREATE INDEX browsers_activity_idx ON browsers(last_active_at);
