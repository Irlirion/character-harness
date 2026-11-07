ALTER TABLE social_events ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'minecraft';
ALTER TABLE social_events ADD COLUMN IF NOT EXISTS turn_expires_at timestamptz;
ALTER TABLE social_events DROP CONSTRAINT IF EXISTS social_events_author_provenance_check;
ALTER TABLE social_events ADD CONSTRAINT social_events_author_provenance_check CHECK
 (author_provenance IN ('legacy_unverified_input','owner_input','fabric_profile_context','minecraft_system_chat','minecraft_voice_stt','telegram'));
CREATE TABLE IF NOT EXISTS telegram_accounts (
 bot_id text PRIMARY KEY, character_id text NOT NULL REFERENCES characters(id),
 username text NOT NULL, status text NOT NULL DEFAULT 'starting', retry_at timestamptz, poll_owner uuid, poll_until timestamptz,
 next_offset bigint NOT NULL DEFAULT 0, last_poll_at timestamptz, observation_gap boolean NOT NULL DEFAULT false,
 UNIQUE(character_id)
);
CREATE TABLE IF NOT EXISTS telegram_bindings (
 id uuid PRIMARY KEY, bot_id text NOT NULL REFERENCES telegram_accounts(bot_id),
 character_id text NOT NULL REFERENCES characters(id), chat_id text NOT NULL,
 audience_id text NOT NULL UNIQUE, kind text NOT NULL CHECK(kind IN ('private','group')),
 enabled boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(bot_id,chat_id)
);
CREATE TABLE IF NOT EXISTS telegram_discovered_chats (
 bot_id text NOT NULL REFERENCES telegram_accounts(bot_id), chat_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('private','group')), observed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(bot_id,chat_id)
);
CREATE TABLE IF NOT EXISTS telegram_updates (
 bot_id text NOT NULL REFERENCES telegram_accounts(bot_id), update_id bigint NOT NULL,
 disposition text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(bot_id,update_id)
);
CREATE TABLE IF NOT EXISTS telegram_messages (
 seq bigserial PRIMARY KEY, binding_id uuid NOT NULL REFERENCES telegram_bindings(id),
 message_id text NOT NULL, author_id text NOT NULL, text text NOT NULL,
 reply_to text, direct boolean NOT NULL DEFAULT false,
 incoming boolean NOT NULL DEFAULT true, observed_at timestamptz NOT NULL DEFAULT now(),
 consumed boolean NOT NULL DEFAULT false, UNIQUE(binding_id,message_id)
);
CREATE TABLE IF NOT EXISTS telegram_decisions (
 event_id uuid PRIMARY KEY REFERENCES social_events(id), binding_id uuid NOT NULL REFERENCES telegram_bindings(id),
 first_seq bigint NOT NULL, last_seq bigint NOT NULL, reply_to text NOT NULL,
 direct boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 outcome text, completion_epoch integer, completion_payload text, UNIQUE(binding_id,last_seq)
);
CREATE TABLE IF NOT EXISTS telegram_outbox (
 id uuid PRIMARY KEY, event_id uuid NOT NULL UNIQUE REFERENCES social_events(id),
 binding_id uuid NOT NULL REFERENCES telegram_bindings(id), revision integer NOT NULL,
 text text NOT NULL, reply_to text NOT NULL, direct boolean NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','sending','sent','retry_wait','failed','cancelled','expired','unknown')),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 retry_at timestamptz, claim_id uuid, lease_until timestamptz,
 send_started_at timestamptz, message_id text, error_code text
);
CREATE INDEX IF NOT EXISTS telegram_queue ON telegram_outbox(state,created_at);
CREATE INDEX IF NOT EXISTS telegram_pending_messages ON telegram_messages(binding_id,seq) WHERE NOT consumed;

ALTER TABLE replies DROP CONSTRAINT IF EXISTS replies_channel_check;
ALTER TABLE replies ADD CONSTRAINT replies_channel_check CHECK(channel IN ('local','voice','chat','telegram'));
ALTER TABLE social_people DROP CONSTRAINT IF EXISTS social_people_provenance_check;
ALTER TABLE social_people ADD CONSTRAINT social_people_provenance_check CHECK(provenance IN ('owner_input','fabric_profile_context','minecraft_system_chat','minecraft_voice_stt','legacy_unverified_input','telegram'));
