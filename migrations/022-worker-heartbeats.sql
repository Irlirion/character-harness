CREATE TABLE worker_heartbeats (
  character_id text NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  component text NOT NULL CHECK (component IN ('codex-engine','pi-engine','audio-worker','tts-service')),
  state text NOT NULL CHECK (state IN ('starting','ready','busy','degraded','stopping')),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,80}$'),
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (character_id, component)
);
