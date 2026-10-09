-- SET LOCAL app.owner_id is set only from the authenticated server context.
-- FORCE also applies to ordinary table owners. Superusers/BYPASSRLS are rejected by v2 runtime startup.
DO $migration$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['consent_records','v2_projects','temporary_content_keys','conversations','requests_v2','agent_runs','outbox_events','v2_rate_limits','question_instances','v2_messages','answer_revisions','memory_items','conversation_summaries','safety_episodes','guidance_versions','action_plans','plan_feedback','memory_derivations','memory_suppressions','deletion_requests','audit_events','agent_run_steps'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY owner_isolation ON %I USING(owner_id = nullif(current_setting(''app.owner_id'',true),'''')::uuid) WITH CHECK(owner_id = nullif(current_setting(''app.owner_id'',true),'''')::uuid)',t);
  END LOOP;
END $migration$;
