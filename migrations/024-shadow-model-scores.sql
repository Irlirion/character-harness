ALTER TABLE shadow_decisions
  DROP CONSTRAINT shadow_decisions_pkey,
  ADD PRIMARY KEY (event_id, model),
  ADD COLUMN scores jsonb;
