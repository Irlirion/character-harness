CREATE TABLE shadow_decisions (
  event_id uuid PRIMARY KEY REFERENCES social_events(id) ON DELETE CASCADE,
  model text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('silence','quick_reply','known_skill','delegate')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 200),
  latency_ms integer NOT NULL CHECK (latency_ms >= 0)
);
