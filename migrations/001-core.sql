CREATE TABLE IF NOT EXISTS characters (
  id text PRIMARY KEY, name text NOT NULL, persona text NOT NULL,
  paused boolean NOT NULL DEFAULT false, epoch integer NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS memories (
  id uuid PRIMARY KEY, character_id text NOT NULL REFERENCES characters(id),
  audience_id text NOT NULL, text text NOT NULL, source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memories_scope ON memories(character_id, audience_id, created_at);
CREATE TABLE IF NOT EXISTS social_events (
  id uuid PRIMARY KEY, character_id text NOT NULL REFERENCES characters(id),
  audience_id text NOT NULL, source_key text NOT NULL,
  author_id text NOT NULL, text text NOT NULL, reply_to text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(character_id, audience_id, source_key)
);
CREATE TABLE IF NOT EXISTS operations (
  id uuid PRIMARY KEY, character_id text NOT NULL REFERENCES characters(id),
  audience_id text NOT NULL, invocation_id text NOT NULL, payload text NOT NULL,
  status text NOT NULL CHECK(status IN ('succeeded')),
  result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(character_id, audience_id, invocation_id)
);
ALTER TABLE social_events ADD COLUMN processed boolean NOT NULL DEFAULT false;
CREATE TABLE replies (
  event_id uuid PRIMARY KEY REFERENCES social_events(id), text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE characters ADD COLUMN lease_until timestamptz;
ALTER TABLE social_events ADD COLUMN attempts integer NOT NULL DEFAULT 0;
