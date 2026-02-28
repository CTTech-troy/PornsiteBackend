-- 005_users_creator_verified.sql
-- Store creator application on user and verified status (pending until admin approves)
ALTER TABLE users ADD COLUMN IF NOT EXISTS creator_application jsonb DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS verified text DEFAULT 'none';
