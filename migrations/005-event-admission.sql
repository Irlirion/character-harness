CREATE INDEX social_events_pending ON social_events(character_id) WHERE NOT processed;
CREATE INDEX social_events_author_recent ON social_events(character_id, audience_id, author_id, created_at);
