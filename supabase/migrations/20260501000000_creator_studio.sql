-- Creator Studio enhancements
-- Adds bank-detail columns to creator_payout_requests and
-- social / notification columns to creators.
--
-- Run via: Supabase Dashboard → SQL Editor → paste → Run
-- Or:      node backend/apply-migration.js  (if DATABASE_URL is set)

-- Bank detail columns on payout requests
ALTER TABLE IF EXISTS creator_payout_requests
  ADD COLUMN IF NOT EXISTS bank_name       text,
  ADD COLUMN IF NOT EXISTS account_number  text;

-- Extended profile columns on creators
ALTER TABLE IF EXISTS creators
  ADD COLUMN IF NOT EXISTS social_links       jsonb DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS notification_prefs jsonb DEFAULT '{}';
