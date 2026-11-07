CREATE TABLE image_jobs (
 id uuid PRIMARY KEY, character_id text NOT NULL REFERENCES characters(id),
 event_id uuid NOT NULL UNIQUE REFERENCES social_events(id), binding_id uuid NOT NULL REFERENCES telegram_bindings(id),
 revision integer NOT NULL, prompt text NOT NULL, caption text NOT NULL,
 state text NOT NULL CHECK(state IN ('queued','generating','ready','failed','unknown','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, claim_id uuid, lease_until timestamptz,
 error_code text
);
CREATE INDEX image_jobs_queue ON image_jobs(character_id,state,created_at);
ALTER TABLE telegram_outbox ADD COLUMN image_job_id uuid UNIQUE REFERENCES image_jobs(id);
ALTER TABLE telegram_outbox ADD COLUMN image_data bytea;
ALTER TABLE telegram_outbox ADD CONSTRAINT image_size CHECK(image_data IS NULL OR octet_length(image_data)<=10485760);
ALTER TABLE telegram_outbox DROP CONSTRAINT telegram_outbox_event_id_key;
CREATE UNIQUE INDEX telegram_text_event ON telegram_outbox(event_id) WHERE image_job_id IS NULL;
