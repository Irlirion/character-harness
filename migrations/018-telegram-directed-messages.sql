-- One reviewed owner-directed group post per private event, separate from unsolicited initiative.
CREATE TABLE telegram_directed_requests (
 source_event_id uuid PRIMARY KEY REFERENCES social_events(id),
 source_binding_id uuid NOT NULL REFERENCES telegram_bindings(id), source_revision integer NOT NULL,
 target_binding_id uuid NOT NULL REFERENCES telegram_bindings(id), target_revision integer NOT NULL,
 policy_version text NOT NULL, profile_hash text NOT NULL, payload_hash text NOT NULL,
 text text NOT NULL CHECK(length(text) BETWEEN 1 AND 1000), text_hash text NOT NULL,
 outbox_id uuid UNIQUE REFERENCES telegram_outbox(id), created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE telegram_outbox ADD COLUMN directed_source_event uuid UNIQUE REFERENCES telegram_directed_requests(source_event_id);
ALTER TABLE telegram_outbox ADD CONSTRAINT directed_delivery_shape CHECK
 (directed_source_event IS NULL OR (direct AND reply_to IS NULL AND runtime_turn_id IS NULL AND autonomy_revision IS NULL));
