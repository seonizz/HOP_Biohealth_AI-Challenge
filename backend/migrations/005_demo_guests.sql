-- One-click internal demo visitors are isolated accounts with a hard expiry.
ALTER TABLE users ADD COLUMN demo_expires_at timestamptz;
CREATE INDEX users_demo_expiry ON users(demo_expires_at) WHERE demo_expires_at IS NOT NULL;
