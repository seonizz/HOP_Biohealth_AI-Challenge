ALTER TABLE model_selection
  ADD COLUMN result_profile_id TEXT CHECK (result_profile_id IN ('local12b', 'gpu31b')),
  ADD CONSTRAINT model_selection_distinct_roles CHECK (profile_id <> result_profile_id);
