CREATE TABLE browsers (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  csrf TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX browsers_expiry_idx ON browsers(expires_at);

CREATE TABLE intakes (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES browsers(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  content TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE(id,owner)
);

CREATE INDEX intakes_owner_idx ON intakes(owner);

CREATE TABLE patient_states (
  intake_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  content TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY(intake_id,owner) REFERENCES intakes(id,owner) ON DELETE CASCADE
);

CREATE TABLE patient_state_revisions (
  intake_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  reason TEXT NOT NULL CHECK (reason IN ('created','user_answer','correction','model_update')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(intake_id,revision),
  FOREIGN KEY(intake_id,owner) REFERENCES intakes(id,owner) ON DELETE CASCADE
);

CREATE TABLE records (
  id TEXT NOT NULL,
  owner TEXT NOT NULL REFERENCES browsers(id) ON DELETE CASCADE,
  intake_id TEXT,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(owner,id),
  UNIQUE(owner,intake_id),
  FOREIGN KEY(intake_id,owner) REFERENCES intakes(id,owner) ON DELETE CASCADE
);

CREATE INDEX records_owner_date_idx ON records(owner,created_at DESC,id DESC);

-- Numeric IDs preserve the existing UI's contract; a sequence cannot collide by clock time.
CREATE SEQUENCE record_ids AS BIGINT MAXVALUE 9007199254740991;

CREATE TABLE column_states (
  owner TEXT NOT NULL REFERENCES browsers(id) ON DELETE CASCADE,
  article TEXT NOT NULL,
  read BOOLEAN NOT NULL DEFAULT FALSE,
  saved BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY(owner,article)
);
