CREATE TABLE social_people (
  id uuid PRIMARY KEY,
  character_id text NOT NULL REFERENCES characters(id),
  audience_id text NOT NULL,
  channel text NOT NULL,
  external_id text NOT NULL,
  display_name text NOT NULL,
  provenance text NOT NULL CHECK (provenance IN ('owner_input','fabric_profile_context','minecraft_system_chat','minecraft_voice_stt','legacy_unverified_input')),
  identity_status text NOT NULL CHECK (identity_status IN ('unverified','verified')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(character_id,audience_id,channel,external_id),
  UNIQUE(id,character_id,audience_id)
);
CREATE TABLE social_facts (
  id uuid PRIMARY KEY,
  character_id text NOT NULL,
  audience_id text NOT NULL,
  person_id uuid NOT NULL,
  content text NOT NULL,
  source_event_id uuid NOT NULL REFERENCES social_events(id),
  confidence real NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  epistemic_status text NOT NULL CHECK(epistemic_status IN ('observed','inferred','superseded')),
  visibility text NOT NULL CHECK(visibility='audience'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(person_id,character_id,audience_id) REFERENCES social_people(id,character_id,audience_id)
);
CREATE INDEX social_facts_scope ON social_facts(character_id,audience_id,person_id,created_at DESC);
CREATE TABLE social_relationships (
  id uuid PRIMARY KEY,
  character_id text NOT NULL,
  audience_id text NOT NULL,
  person_id uuid NOT NULL,
  note text NOT NULL,
  source_event_id uuid NOT NULL REFERENCES social_events(id),
  version integer NOT NULL CHECK(version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(person_id,character_id,audience_id) REFERENCES social_people(id,character_id,audience_id)
);
CREATE INDEX social_relationships_scope ON social_relationships(character_id,audience_id,person_id,version DESC);
CREATE TABLE social_commitments (
  id uuid PRIMARY KEY,
  character_id text NOT NULL,
  audience_id text NOT NULL,
  commitment_key text NOT NULL,
  person_id uuid NOT NULL,
  description text NOT NULL,
  source_event_id uuid NOT NULL REFERENCES social_events(id),
  due_at timestamptz,
  status text NOT NULL CHECK(status IN ('open','fulfilled','cancelled')),
  evidence_event_id uuid REFERENCES social_events(id),
  version integer NOT NULL CHECK(version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(character_id,audience_id,commitment_key,version),
  FOREIGN KEY(person_id,character_id,audience_id) REFERENCES social_people(id,character_id,audience_id)
);
CREATE INDEX social_commitments_open ON social_commitments(character_id,audience_id,status,updated_at);
CREATE TABLE social_working_states (
  character_id text NOT NULL REFERENCES characters(id),
  audience_id text NOT NULL,
  version integer NOT NULL CHECK(version > 0),
  topic text,
  goal text,
  open_questions jsonb NOT NULL,
  commitment_keys jsonb NOT NULL,
  last_event_id uuid REFERENCES social_events(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(character_id,audience_id)
);
ALTER TABLE social_events ADD COLUMN completion_payload jsonb;
ALTER TABLE social_events ADD COLUMN completion_memory_result jsonb;
