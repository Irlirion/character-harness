-- Additive foundation only. No bootstrap, autonomous consumer or external effects.
CREATE TABLE runtime_activities (
  id uuid PRIMARY KEY, character_id text NOT NULL REFERENCES characters(id),
  audience_id text NOT NULL, origin text NOT NULL CHECK(origin='owner'),
  requested_by text NOT NULL CHECK(requested_by='owner'),
  invocation_id text NOT NULL, create_payload jsonb NOT NULL,
  objective text NOT NULL CHECK(length(objective) BETWEEN 1 AND 4000),
  status text NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','running','waiting_time','needs_input','completed','failed','cancelled')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  max_turns integer NOT NULL CHECK(max_turns BETWEEN 1 AND 100),
  turns_used integer NOT NULL DEFAULT 0 CHECK(turns_used>=0 AND turns_used<=max_turns),
  checkpoint_id uuid, question text, input_reply text, summary text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(character_id,audience_id,id), UNIQUE(character_id,audience_id,invocation_id)
);
CREATE TABLE runtime_turns (
  id uuid PRIMARY KEY, character_id text NOT NULL, audience_id text NOT NULL,
  activity_id uuid NOT NULL, request_id text NOT NULL, epoch integer NOT NULL,
  lease_token uuid NOT NULL, lease_until timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','finished','interrupted')),
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  UNIQUE(character_id,id), UNIQUE(character_id,audience_id,id),
  UNIQUE(character_id,audience_id,activity_id,id),
  UNIQUE(character_id,audience_id,request_id),
  FOREIGN KEY(character_id,audience_id,activity_id) REFERENCES runtime_activities(character_id,audience_id,id)
);
CREATE UNIQUE INDEX runtime_one_running_turn ON runtime_turns(character_id) WHERE status='running';
CREATE INDEX runtime_turn_budget ON runtime_turns(character_id,created_at);
CREATE TABLE runtime_checkpoints (
  id uuid PRIMARY KEY, character_id text NOT NULL, audience_id text NOT NULL,
  activity_id uuid NOT NULL, turn_id uuid NOT NULL, state text NOT NULL CHECK(length(state)<=16000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(character_id,audience_id,activity_id,id),
  FOREIGN KEY(character_id,audience_id,activity_id) REFERENCES runtime_activities(character_id,audience_id,id),
  FOREIGN KEY(character_id,audience_id,activity_id,turn_id) REFERENCES runtime_turns(character_id,audience_id,activity_id,id)
);
ALTER TABLE runtime_activities ADD CONSTRAINT runtime_checkpoint_scope
  FOREIGN KEY(character_id,audience_id,id,checkpoint_id)
  REFERENCES runtime_checkpoints(character_id,audience_id,activity_id,id);
CREATE TABLE runtime_wakeups (
  id uuid PRIMARY KEY, character_id text NOT NULL, audience_id text NOT NULL,
  activity_id uuid NOT NULL, dedup_key text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('created','continue','at_time','recovery','owner_input')),
  available_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','consumed','cancelled')),
  consumed_by_turn_id uuid,
  UNIQUE(activity_id,dedup_key),
  FOREIGN KEY(character_id,audience_id,activity_id) REFERENCES runtime_activities(character_id,audience_id,id),
  FOREIGN KEY(character_id,audience_id,activity_id,consumed_by_turn_id) REFERENCES runtime_turns(character_id,audience_id,activity_id,id)
);
CREATE INDEX runtime_due_wakeups ON runtime_wakeups(character_id,audience_id,available_at,id) WHERE state='pending';
CREATE TABLE runtime_decisions (
  turn_id uuid PRIMARY KEY REFERENCES runtime_turns(id),
  invocation_id text NOT NULL, payload jsonb NOT NULL, result jsonb NOT NULL
);
CREATE TABLE runtime_audit (
  id bigserial PRIMARY KEY, activity_id uuid NOT NULL REFERENCES runtime_activities(id),
  version integer NOT NULL, actor text NOT NULL CHECK(actor IN ('owner','runtime','engine')),
  transition text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE characters ADD COLUMN active_runtime_turn_id uuid;
ALTER TABLE characters ADD CONSTRAINT runtime_character_turn_scope
  FOREIGN KEY(id,active_runtime_turn_id) REFERENCES runtime_turns(character_id,id);

-- Existing owner pause/resume and legacy claims also fence the new runtime.
-- Keep this atomic with the epoch change, regardless of which consumer performs it.
CREATE FUNCTION runtime_fence_turns() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t record; a record;
BEGIN
  IF NEW.epoch = OLD.epoch AND NOT NEW.paused THEN RETURN NEW; END IF;
  FOR t IN UPDATE runtime_turns SET status='interrupted',finished_at=now()
    WHERE character_id=NEW.id AND status='running'
      AND (epoch<>NEW.epoch OR NEW.paused) RETURNING *
  LOOP
    UPDATE runtime_activities SET status='ready',version=version+1,updated_at=now()
      WHERE id=t.activity_id AND status='running' RETURNING * INTO a;
    IF FOUND THEN
      INSERT INTO runtime_wakeups(id,character_id,audience_id,activity_id,dedup_key,kind,available_at)
        VALUES(t.id,t.character_id,t.audience_id,t.activity_id,'recovery:'||t.id,'recovery',now())
        ON CONFLICT(activity_id,dedup_key) DO NOTHING;
      INSERT INTO runtime_audit(activity_id,version,actor,transition)
        VALUES(a.id,a.version,'runtime','authority_revoked');
    END IF;
    IF NEW.active_runtime_turn_id=t.id THEN NEW.active_runtime_turn_id=NULL; END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER runtime_fence_turns BEFORE UPDATE OF epoch,paused ON characters
  FOR EACH ROW EXECUTE FUNCTION runtime_fence_turns();
