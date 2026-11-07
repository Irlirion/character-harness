ALTER TABLE characters ADD COLUMN IF NOT EXISTS active_event_id uuid REFERENCES social_events(id);
CREATE TABLE social_memory_staging (
  character_id text NOT NULL REFERENCES characters(id),
  audience_id text NOT NULL,
  event_id uuid NOT NULL REFERENCES social_events(id),
  epoch integer NOT NULL CHECK(epoch > 0),
  stage_version integer NOT NULL CHECK(stage_version > 0),
  proposal jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(character_id,audience_id,event_id,epoch)
);
CREATE TABLE social_memory_stage_invocations (
  character_id text NOT NULL,
  audience_id text NOT NULL,
  event_id uuid NOT NULL,
  epoch integer NOT NULL,
  invocation_id text NOT NULL,
  payload jsonb NOT NULL,
  stage_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(character_id,audience_id,event_id,epoch,invocation_id),
  FOREIGN KEY(character_id,audience_id,event_id,epoch)
    REFERENCES social_memory_staging(character_id,audience_id,event_id,epoch) ON DELETE CASCADE
);
