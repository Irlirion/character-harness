CREATE TABLE runtime_review_dispatches (
 id uuid PRIMARY KEY, character_id text NOT NULL REFERENCES characters(id), audience_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX runtime_review_dispatch_budget ON runtime_review_dispatches(character_id,created_at);
CREATE TABLE runtime_review_retries (
 character_id text NOT NULL, audience_id text NOT NULL, request_id uuid NOT NULL,
 activity_id uuid NOT NULL, activity_version integer NOT NULL, policy_version text NOT NULL, payload_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(character_id,audience_id,request_id),
 FOREIGN KEY(character_id,audience_id,activity_id) REFERENCES runtime_activities(character_id,audience_id,id)
);
CREATE TABLE runtime_reviewer_bindings (
 character_id text NOT NULL, policy_version text NOT NULL, rules_hash text NOT NULL,
 PRIMARY KEY(character_id,policy_version),
 FOREIGN KEY(character_id,policy_version) REFERENCES runtime_policy_profiles(character_id,version)
);
