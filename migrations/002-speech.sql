CREATE TABLE speech_jobs (
 id uuid PRIMARY KEY, character_id text NOT NULL REFERENCES characters(id), audience_id text NOT NULL,
 request_id text NOT NULL, text text NOT NULL, epoch integer NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','playing','completed','failed','cancelled','unknown')),
 claim_id uuid, expires_at timestamptz NOT NULL, claimed_at timestamptz, finished_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(character_id,audience_id,request_id)
);
CREATE INDEX speech_scope ON speech_jobs(character_id,audience_id,created_at);
