ALTER TABLE replies ADD COLUMN channel text NOT NULL DEFAULT 'local' CHECK(channel IN ('local','voice','chat'));
ALTER TABLE replies ADD COLUMN epoch integer;
