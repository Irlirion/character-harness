ALTER TABLE social_events DROP CONSTRAINT IF EXISTS social_events_author_provenance_check;
ALTER TABLE social_events ADD CONSTRAINT social_events_author_provenance_check
  CHECK (author_provenance IN ('legacy_unverified_input', 'owner_input', 'fabric_profile_context', 'minecraft_system_chat', 'minecraft_voice_stt'));
ALTER TABLE social_events ADD COLUMN IF NOT EXISTS author_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE world_observations (
  character_id text NOT NULL REFERENCES characters(id),
  audience_id text NOT NULL,
  session_id uuid NOT NULL,
  connected boolean NOT NULL,
  server text,
  snapshot jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(character_id,audience_id)
);
