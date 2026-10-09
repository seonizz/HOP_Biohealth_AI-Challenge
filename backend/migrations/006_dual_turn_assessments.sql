-- Per-turn model assessments are encrypted with the same project key as messages.
-- Project/account deletion cascades; deleting a source message removes its assessment and alerts.
CREATE TABLE turn_assessments (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  project_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  run_id uuid NOT NULL,
  response_id uuid,
  input_revision integer NOT NULL,
  evaluation_status smallint NOT NULL CHECK (evaluation_status IN (0,1,2,3)),
  model_id text NOT NULL,
  model_sha256 text NOT NULL,
  prompt_profile text NOT NULL,
  prompt_version text NOT NULL,
  schema_version integer NOT NULL,
  rubric_version text NOT NULL,
  threshold_version text NOT NULL,
  attempts smallint NOT NULL CHECK (attempts BETWEEN 0 AND 2),
  encrypted_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(turn_id), UNIQUE(id,owner_id),
  FOREIGN KEY(turn_id,conversation_id,project_id,owner_id)
    REFERENCES v2_messages(id,conversation_id,project_id,owner_id) ON DELETE CASCADE
);
CREATE INDEX turn_assessments_history ON turn_assessments(owner_id,project_id,conversation_id,created_at DESC);

CREATE TABLE assessment_sources (
  owner_id uuid NOT NULL,
  project_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  assessment_id uuid NOT NULL,
  source_id uuid NOT NULL,
  PRIMARY KEY(assessment_id,source_id),
  FOREIGN KEY(assessment_id,owner_id) REFERENCES turn_assessments(id,owner_id) ON DELETE CASCADE,
  FOREIGN KEY(source_id,conversation_id,project_id,owner_id)
    REFERENCES v2_messages(id,conversation_id,project_id,owner_id) ON DELETE CASCADE
);
CREATE INDEX assessment_sources_by_message ON assessment_sources(owner_id,project_id,source_id);

CREATE TABLE assessment_alerts (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  project_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  assessment_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  response_id uuid NOT NULL,
  reason_code text NOT NULL,
  threshold_version text NOT NULL,
  shown_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(assessment_id,reason_code),
  FOREIGN KEY(assessment_id,owner_id) REFERENCES turn_assessments(id,owner_id) ON DELETE CASCADE,
  FOREIGN KEY(response_id,conversation_id,project_id,owner_id)
    REFERENCES v2_messages(id,conversation_id,project_id,owner_id) ON DELETE CASCADE
);
CREATE INDEX assessment_alerts_pending ON assessment_alerts(owner_id,conversation_id,created_at) WHERE shown_at IS NULL;

ALTER TABLE turn_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE turn_assessments FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON turn_assessments
  USING(owner_id = nullif(current_setting('app.owner_id',true),'')::uuid)
  WITH CHECK(owner_id = nullif(current_setting('app.owner_id',true),'')::uuid);
ALTER TABLE assessment_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessment_alerts FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON assessment_alerts
  USING(owner_id = nullif(current_setting('app.owner_id',true),'')::uuid)
  WITH CHECK(owner_id = nullif(current_setting('app.owner_id',true),'')::uuid);
ALTER TABLE assessment_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessment_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON assessment_sources
  USING(owner_id = nullif(current_setting('app.owner_id',true),'')::uuid)
  WITH CHECK(owner_id = nullif(current_setting('app.owner_id',true),'')::uuid);
