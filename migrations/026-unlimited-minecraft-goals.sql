ALTER TABLE runtime_activities ALTER COLUMN max_turns DROP NOT NULL;
ALTER TABLE runtime_activities ADD CONSTRAINT runtime_unlimited_minecraft_goals
  CHECK (max_turns IS NOT NULL OR (origin='self' AND invocation_id LIKE 'minecraft-self:goal:%'));
UPDATE runtime_activities SET max_turns=NULL
WHERE origin='self' AND invocation_id LIKE 'minecraft-self:goal:%'
  AND status IN ('ready','running','waiting_time','needs_input');
