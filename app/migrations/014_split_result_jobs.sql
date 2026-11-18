CREATE TABLE split_result_jobs (
  intake_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','failed')),
  run_token UUID,
  lease_until TIMESTAMPTZ,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (intake_id,owner) REFERENCES intakes(id,owner) ON DELETE CASCADE,
  CHECK ((status = 'running') = (run_token IS NOT NULL AND lease_until IS NOT NULL))
);
