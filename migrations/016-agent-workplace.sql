-- Scoped virtual desk. No operating-system filesystem authority.
ALTER TABLE runtime_activities DROP CONSTRAINT runtime_activities_origin_check;
ALTER TABLE runtime_activities DROP CONSTRAINT runtime_activities_requested_by_check;
ALTER TABLE runtime_activities ADD CONSTRAINT runtime_origin_authority CHECK
 ((origin='owner' AND requested_by='owner') OR (origin='self' AND requested_by='runtime'));
CREATE TABLE runtime_desks (
 character_id text NOT NULL REFERENCES characters(id), audience_id text NOT NULL,
 revision integer NOT NULL DEFAULT 1, notes text NOT NULL DEFAULT '' CHECK(length(notes)<=4000),
 plan text NOT NULL DEFAULT '' CHECK(length(plan)<=2000), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(character_id,audience_id)
);
CREATE TABLE runtime_autonomy (
 binding_id uuid PRIMARY KEY REFERENCES telegram_bindings(id), enabled boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1, next_wake_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE telegram_outbox ALTER COLUMN reply_to DROP NOT NULL;
ALTER TABLE telegram_outbox ADD COLUMN autonomy_revision integer;
ALTER TABLE telegram_outbox ADD COLUMN autonomy_epoch integer;
ALTER TABLE telegram_outbox ADD CONSTRAINT autonomy_delivery CHECK
 (autonomy_revision IS NULL AND autonomy_epoch IS NULL OR
  autonomy_revision IS NOT NULL AND autonomy_epoch IS NOT NULL AND runtime_turn_id IS NOT NULL AND reply_to IS NULL AND NOT direct);
