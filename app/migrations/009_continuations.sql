-- A continuation belongs to one completed record and never rewrites its intake.
-- Only routing/version metadata is plaintext; messages and derived state are sealed.
CREATE TABLE continuation_sessions (
  id TEXT PRIMARY KEY,
  sequence BIGSERIAL UNIQUE NOT NULL,
  owner TEXT NOT NULL REFERENCES browsers(id) ON DELETE CASCADE,
  source_record_id TEXT NOT NULL,
  source_intake_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  status TEXT NOT NULL CHECK (status IN ('active','pending','retryable','completed')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,owner),
  FOREIGN KEY(owner,source_record_id) REFERENCES records(owner,id) ON DELETE CASCADE,
  FOREIGN KEY(source_intake_id,owner) REFERENCES intakes(id,owner) ON DELETE CASCADE
);

CREATE UNIQUE INDEX continuation_active_source_idx
  ON continuation_sessions(owner,source_record_id) WHERE status <> 'completed';
CREATE INDEX continuation_source_history_idx
  ON continuation_sessions(owner,source_record_id,sequence);

-- Every accepted start token is retained, including a token that reused the
-- already-active session. A retry after completion must not create a new session.
CREATE TABLE continuation_creation_requests (
  owner TEXT NOT NULL,
  request_id TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  continuation_id TEXT,
  PRIMARY KEY(owner,request_id),
  FOREIGN KEY(owner,source_record_id) REFERENCES records(owner,id) ON DELETE CASCADE,
  FOREIGN KEY(continuation_id,owner) REFERENCES continuation_sessions(id,owner) ON DELETE SET NULL (continuation_id)
);
