CREATE TABLE questions (
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_]{0,79}$'),
  kind TEXT NOT NULL CHECK (kind IN ('base','gap')),
  sort_order INTEGER NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  subject TEXT NOT NULL CHECK (subject IN ('patient','supporter','user_goal')),
  definition JSONB NOT NULL CHECK (
    jsonb_typeof(definition) = 'object'
    AND definition ? 'type' AND definition->>'type' IN ('text','one','multi')
    AND definition ? 'q' AND jsonb_typeof(definition->'q') = 'string'
    AND length(definition->>'q') > 0
    AND (NOT definition ? 'opts' OR jsonb_typeof(definition->'opts') = 'array')
  ),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX questions_display_idx ON questions(sort_order,id) WHERE enabled;
