ALTER TABLE social_events
  ADD COLUMN IF NOT EXISTS author_provenance text NOT NULL DEFAULT 'legacy_unverified_input'
    CHECK (author_provenance IN ('legacy_unverified_input', 'owner_input', 'fabric_profile_context', 'minecraft_system_chat')),
  ADD COLUMN IF NOT EXISTS author_trust text NOT NULL DEFAULT 'unverified'
    CHECK (author_trust = 'unverified');
