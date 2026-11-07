ALTER TABLE telegram_bindings ADD COLUMN runtime_control boolean NOT NULL DEFAULT false;
ALTER TABLE telegram_outbox ADD COLUMN runtime_activity_id uuid REFERENCES runtime_activities(id);
ALTER TABLE telegram_outbox ADD COLUMN runtime_activity_version integer;
ALTER TABLE telegram_outbox ADD COLUMN runtime_turn_id uuid REFERENCES runtime_turns(id);
ALTER TABLE telegram_outbox ADD COLUMN runtime_policy_version text;
ALTER TABLE telegram_outbox ADD COLUMN runtime_profile_hash text;
ALTER TABLE telegram_outbox ADD COLUMN runtime_text_hash text;
ALTER TABLE telegram_outbox ADD CONSTRAINT telegram_runtime_delivery_binding CHECK (
 (runtime_activity_id IS NULL AND runtime_activity_version IS NULL AND runtime_turn_id IS NULL AND runtime_policy_version IS NULL AND runtime_profile_hash IS NULL AND runtime_text_hash IS NULL)
 OR (runtime_activity_id IS NOT NULL AND runtime_activity_version IS NOT NULL AND runtime_turn_id IS NOT NULL AND runtime_policy_version IS NOT NULL AND runtime_profile_hash IS NOT NULL AND runtime_text_hash IS NOT NULL)
);
