CREATE TABLE minecraft_tool_receipts (
 character_id text NOT NULL REFERENCES characters(id),
 invocation_id text NOT NULL,
 request_hash text NOT NULL,
 state text NOT NULL CHECK(state IN ('unknown','returned')),
 result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(character_id,invocation_id)
);
