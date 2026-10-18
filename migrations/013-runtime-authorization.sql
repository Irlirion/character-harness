CREATE TABLE runtime_policy_profiles (
 character_id text NOT NULL REFERENCES characters(id), version text NOT NULL, profile_hash text NOT NULL,
 bundle jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(character_id,version)
);
CREATE TABLE runtime_policy_current (
 character_id text PRIMARY KEY REFERENCES characters(id), version text NOT NULL,
 FOREIGN KEY(character_id,version) REFERENCES runtime_policy_profiles(character_id,version)
);
CREATE TABLE runtime_policy_holds (
 activity_id uuid PRIMARY KEY, character_id text NOT NULL, audience_id text NOT NULL, activity_version integer NOT NULL,
 policy_version text NOT NULL, payload_hash text NOT NULL, verdict text NOT NULL CHECK(verdict IN ('deny','needs_review')), rule_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(character_id,audience_id,activity_id) REFERENCES runtime_activities(character_id,audience_id,id)
);
CREATE TABLE runtime_model_grants (
 id uuid PRIMARY KEY, turn_id uuid NOT NULL UNIQUE, activity_id uuid NOT NULL, character_id text NOT NULL, audience_id text NOT NULL,
 policy_version text NOT NULL, profile_hash text NOT NULL, source_hash text NOT NULL, input_hash text NOT NULL,
 approved_input jsonb NOT NULL, persona text NOT NULL, engine text NOT NULL CHECK(engine IN ('pi','codex')), model text NOT NULL,
 state text NOT NULL DEFAULT 'authorized' CHECK(state IN ('authorized','started','finished','blocked')),
 expires_at timestamptz NOT NULL, started_at timestamptz, reserved_tokens integer NOT NULL CHECK(reserved_tokens>0),
 max_model_ms integer NOT NULL CHECK(max_model_ms BETWEEN 100 AND 75000), observed_tokens bigint CHECK(observed_tokens>=0),
 usage_source text CHECK(usage_source IN ('pi_session','codex_notification')), output_hash text,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(character_id,policy_version) REFERENCES runtime_policy_profiles(character_id,version),
 FOREIGN KEY(character_id,audience_id,activity_id,turn_id) REFERENCES runtime_turns(character_id,audience_id,activity_id,id)
);
CREATE INDEX runtime_grant_budget ON runtime_model_grants(character_id,created_at);
CREATE TABLE runtime_policy_audit (
 id bigserial PRIMARY KEY, character_id text NOT NULL REFERENCES characters(id), audience_id text NOT NULL,
 turn_id uuid REFERENCES runtime_turns(id), policy_version text NOT NULL, phase text NOT NULL CHECK(phase IN ('input','output','dispatch')),
 payload_hash text NOT NULL, verdict text NOT NULL CHECK(verdict IN ('allow','deny','needs_review')), rule_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
