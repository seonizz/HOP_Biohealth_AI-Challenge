-- Each ledger has its own FK boundary, revision and authenticated encrypted payload.
-- Domain validators control the versioned JSON inside encryption envelopes.
DO $migration$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['question_instances','v2_messages','answer_revisions','memory_items','conversation_summaries','safety_episodes','guidance_versions','action_plans','plan_feedback'] LOOP
    EXECUTE format('CREATE TABLE %I (
      id uuid PRIMARY KEY, owner_id uuid NOT NULL, project_id uuid NOT NULL, conversation_id uuid NOT NULL,
      revision integer NOT NULL DEFAULT 0 CHECK(revision>=0), sequence_id bigserial NOT NULL,
      status text NOT NULL, encrypted_payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(id,owner_id), UNIQUE(id,project_id,owner_id), UNIQUE(id,conversation_id,project_id,owner_id), UNIQUE(conversation_id,sequence_id),
      FOREIGN KEY(conversation_id,project_id,owner_id) REFERENCES conversations(id,project_id,owner_id) ON DELETE CASCADE
    )',t);
    EXECUTE format('CREATE INDEX ON %I(owner_id,project_id,conversation_id,status)',t);
  END LOOP;
END $migration$;
ALTER TABLE answer_revisions ADD COLUMN question_instance_id uuid NOT NULL;
ALTER TABLE answer_revisions ADD CONSTRAINT answer_instance_owner FOREIGN KEY(question_instance_id,conversation_id,project_id,owner_id) REFERENCES question_instances(id,conversation_id,project_id,owner_id) ON DELETE CASCADE;
ALTER TABLE answer_revisions ADD COLUMN answer_revision integer NOT NULL CHECK(answer_revision>0);
ALTER TABLE answer_revisions ADD CONSTRAINT answer_revision_unique UNIQUE(question_instance_id,answer_revision);
CREATE UNIQUE INDEX answers_one_current ON answer_revisions(question_instance_id) WHERE status='current';
CREATE TABLE memory_derivations (
  owner_id uuid NOT NULL, project_id uuid NOT NULL, parent_id uuid NOT NULL, child_id uuid NOT NULL,
  child_type text NOT NULL, PRIMARY KEY(parent_id,child_id), CHECK(parent_id<>child_id),
  FOREIGN KEY(project_id,owner_id) REFERENCES v2_projects(id,owner_id) ON DELETE CASCADE
);
CREATE TABLE memory_suppressions (
  owner_id uuid NOT NULL, project_id uuid NOT NULL, source_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,project_id,source_id),
  FOREIGN KEY(project_id,owner_id) REFERENCES v2_projects(id,owner_id) ON DELETE CASCADE
);
CREATE TABLE deletion_requests (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, scope text NOT NULL, random_resource_id uuid NOT NULL,
  online_purged boolean NOT NULL DEFAULT false, derived_purged boolean NOT NULL DEFAULT false,
  backup_expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
  purge_after timestamptz NOT NULL DEFAULT now()+interval '37 days', created_at timestamptz NOT NULL DEFAULT now(),
  receipt_hash text, receipt_expires_at timestamptz
);
CREATE TABLE audit_events (
  id bigserial PRIMARY KEY, owner_id uuid NOT NULL, action text NOT NULL, resource_id uuid,
  result text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
-- Enumeration for maintenance after an account is deleted; contains no content or receipt secrets.
CREATE TABLE deletion_index (
  id uuid PRIMARY KEY REFERENCES deletion_requests(id) ON DELETE CASCADE, owner_id uuid NOT NULL
);
CREATE TABLE agent_run_steps (
  owner_id uuid NOT NULL, run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  step_no integer NOT NULL CHECK(step_no BETWEEN 1 AND 10), kind text NOT NULL,
  status text NOT NULL, duration_ms integer, error_code text, PRIMARY KEY(run_id,step_no)
);
CREATE INDEX ON agent_runs(status,lease_until,created_at);
CREATE INDEX ON memory_derivations(owner_id,project_id,parent_id);
CREATE INDEX ON v2_projects(owner_id,updated_at DESC,id);
CREATE INDEX ON outbox_events(created_at);
