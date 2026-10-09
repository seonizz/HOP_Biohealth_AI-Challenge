-- Additive: migration 001 and legacy data are never rewritten.
ALTER TABLE users ADD COLUMN consent_epoch integer NOT NULL DEFAULT 0 CHECK (consent_epoch >= 0);
ALTER TABLE projects ADD COLUMN api_version smallint NOT NULL DEFAULT 1 CHECK (api_version IN (1,2));
ALTER TABLE projects ADD CONSTRAINT projects_id_owner UNIQUE(id,owner);

CREATE TABLE consent_records (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('service_processing','sensitive_processing','history_storage','cross_session_memory')),
  version text NOT NULL, accepted boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), sequence_id bigserial NOT NULL
);
CREATE TABLE v2_projects (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 0 CHECK(revision>=0), memory_revision integer NOT NULL DEFAULT 0 CHECK(memory_revision>=0),
  deletion_epoch integer NOT NULL DEFAULT 0 CHECK(deletion_epoch>=0),
  encrypted_payload jsonb NOT NULL, temporary boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,owner_id), FOREIGN KEY(id,owner_id) REFERENCES projects(id,owner) ON DELETE CASCADE
);
-- Keys for history opt-out projects are deliberately excluded from backups.
-- Loss of this UNLOGGED table makes the associated temporary ciphertext unreadable.
CREATE UNLOGGED TABLE temporary_content_keys (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, encrypted_key jsonb NOT NULL, expires_at timestamptz NOT NULL,
  FOREIGN KEY(id,owner_id) REFERENCES v2_projects(id,owner_id) ON DELETE CASCADE
);
CREATE TABLE conversations (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, project_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 0 CHECK(revision>=0), safety_revision integer NOT NULL DEFAULT 0 CHECK(safety_revision>=0),
  state text NOT NULL CHECK(state IN ('SETUP','EXPLORING','REVIEWING','GUIDANCE','FOLLOW_UP','SAFETY_HOLD','COMPLETED','ARCHIVED')),
  encrypted_payload jsonb NOT NULL, active_run_id uuid, event_sequence bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,owner_id), UNIQUE(id,project_id,owner_id),
  FOREIGN KEY(project_id,owner_id) REFERENCES v2_projects(id,owner_id) ON DELETE CASCADE
);
CREATE TABLE requests_v2 (
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, scope_id text NOT NULL, request_id uuid NOT NULL,
  canonical_input_hash char(64) NOT NULL, response_ref jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,scope_id,request_id)
);
CREATE TABLE agent_runs (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, project_id uuid NOT NULL, conversation_id uuid NOT NULL,
  status text NOT NULL CHECK(status IN ('ACCEPTED','RUNNING','SUCCEEDED','FAILED','CANCELLED','SUPERSEDED')),
  input_revision integer NOT NULL, project_revision integer NOT NULL, memory_revision integer NOT NULL, safety_revision integer NOT NULL,
  consent_epoch integer NOT NULL, deletion_epoch integer NOT NULL,
  fence_token bigint NOT NULL DEFAULT 0, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
  deadline_at timestamptz NOT NULL DEFAULT now()+interval '180 seconds',
  encrypted_payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,owner_id), FOREIGN KEY(conversation_id,project_id,owner_id) REFERENCES conversations(id,project_id,owner_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX agent_runs_one_active ON agent_runs(conversation_id) WHERE status IN ('ACCEPTED','RUNNING');
-- Metadata-only scheduling table. Model access still requires owner RLS context.
CREATE TABLE agent_queue (
  run_id uuid PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE model_slots (
  id integer PRIMARY KEY CHECK(id=1), run_id uuid, fence_token bigint NOT NULL DEFAULT 0, lease_until timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0, circuit_until timestamptz
);
INSERT INTO model_slots(id) VALUES (1);
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, project_id uuid NOT NULL, conversation_id uuid NOT NULL,
  sequence_id bigint NOT NULL, type text NOT NULL, resource_ref uuid,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(conversation_id,sequence_id),
  FOREIGN KEY(conversation_id,project_id,owner_id) REFERENCES conversations(id,project_id,owner_id) ON DELETE CASCADE
);
CREATE TABLE v2_rate_limits (
  owner_id uuid NOT NULL, bucket text NOT NULL, started_at timestamptz NOT NULL, count integer NOT NULL,
  PRIMARY KEY(owner_id,bucket)
);
