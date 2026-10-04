ALTER TABLE social_events ADD COLUMN IF NOT EXISTS reply_delivered boolean NOT NULL DEFAULT false;
