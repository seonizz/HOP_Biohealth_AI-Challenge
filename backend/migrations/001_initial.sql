-- Applied transactionally under a schema-specific advisory lock.
-- Creates no database, deletes no schema, and never stores raw tokens.
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_normalized_email CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash char(64) PRIMARY KEY,
  owner uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT sessions_valid_lifetime CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS sessions_owner ON sessions(owner);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY,
  owner uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  status text NOT NULL,
  profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  domains jsonb NOT NULL DEFAULT '[]'::jsonb,
  pending_question_id smallint,
  revision integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT projects_profile_object CHECK (jsonb_typeof(profile) = 'object'),
  CONSTRAINT projects_domains_array CHECK (jsonb_typeof(domains) = 'array'),
  CONSTRAINT projects_question_range CHECK (pending_question_id BETWEEN 1 AND 17),
  CONSTRAINT projects_revision_nonnegative CHECK (revision >= 0)
);
CREATE INDEX IF NOT EXISTS project_owner ON projects(owner,updated_at DESC);
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY,
  sequence_id bigserial NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user','assistant','system')),
  content text NOT NULL,
  created_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT messages_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX IF NOT EXISTS message_project ON messages(project_id,sequence_id DESC);
CREATE TABLE IF NOT EXISTS requests (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  input_hash char(64) NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id,request_id)
);
CREATE TABLE IF NOT EXISTS profile_versions (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  profile jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id,revision),
  CONSTRAINT profile_versions_profile_object CHECK (jsonb_typeof(profile) = 'object')
);
