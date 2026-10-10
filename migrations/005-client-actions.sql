CREATE TABLE client_actions (
  id uuid PRIMARY KEY,
  character_id text NOT NULL REFERENCES characters(id),
  audience_id text NOT NULL,
  invocation_id text NOT NULL,
  epoch integer NOT NULL,
  session_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('walk', 'turn')),
  args jsonb NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms BETWEEN 0 AND 1200),
  state text NOT NULL CHECK (state IN ('pending', 'claimed', 'completed', 'failed', 'cancelled', 'expired')),
  claim_id uuid,
  evidence jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE(character_id, audience_id, invocation_id)
);
CREATE INDEX client_actions_claim ON client_actions(character_id, audience_id, created_at)
  WHERE state = 'pending';
