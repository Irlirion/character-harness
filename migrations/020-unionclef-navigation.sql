ALTER TABLE client_actions DROP CONSTRAINT client_actions_kind_check;
ALTER TABLE client_actions ADD CONSTRAINT client_actions_kind_check CHECK(kind IN ('walk','turn','goto'));
ALTER TABLE client_actions DROP CONSTRAINT client_actions_duration_ms_check;
ALTER TABLE client_actions ADD CONSTRAINT client_actions_duration_ms_check CHECK(
 (kind='goto' AND duration_ms BETWEEN 1000 AND 20000) OR (kind IN ('walk','turn') AND duration_ms BETWEEN 0 AND 1200));
