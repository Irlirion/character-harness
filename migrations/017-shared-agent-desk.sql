-- One character-wide desk. Existing audience notebooks are not automatically disclosed.
CREATE TABLE runtime_shared_desks (
 character_id text PRIMARY KEY REFERENCES characters(id), revision integer NOT NULL DEFAULT 1,
 notes text NOT NULL DEFAULT '' CHECK(length(notes)<=4000),
 plan text NOT NULL DEFAULT '' CHECK(length(plan)<=2000),
 source_turn_id uuid, updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(character_id,source_turn_id) REFERENCES runtime_turns(character_id,id)
);
