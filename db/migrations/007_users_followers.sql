-- Add followers count to users for creator profiles
ALTER TABLE users ADD COLUMN IF NOT EXISTS followers INTEGER NOT NULL DEFAULT 0;
