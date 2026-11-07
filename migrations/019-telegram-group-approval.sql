ALTER TABLE telegram_discovered_chats ADD COLUMN title text NOT NULL DEFAULT '';
ALTER TABLE telegram_discovered_chats ADD COLUMN username text;
ALTER TABLE telegram_discovered_chats ADD COLUMN membership_status text NOT NULL DEFAULT 'unknown';
ALTER TABLE telegram_discovered_chats ADD COLUMN approval_ref uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE;
