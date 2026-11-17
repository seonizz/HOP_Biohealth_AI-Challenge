CREATE TABLE IF NOT EXISTS model_selection (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  profile_id TEXT NOT NULL CHECK (profile_id IN ('local12b', 'gpu31b')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
