CREATE TABLE model_connections (
  id TEXT PRIMARY KEY CHECK (id ~ '^(local12b|gpu31b)_[a-f0-9]{32}$'),
  profile_id TEXT NOT NULL CHECK (profile_id IN ('local12b','gpu31b')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sequence BIGSERIAL UNIQUE NOT NULL
);
