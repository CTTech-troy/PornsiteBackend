-- Add email tracking + tokenised update-link columns to creator_applications
-- Run in Supabase SQL Editor or via migration tooling

ALTER TABLE IF EXISTS creator_applications
  ADD COLUMN IF NOT EXISTS email_sent       boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS decision_at      timestamptz,
  ADD COLUMN IF NOT EXISTS update_token     text,
  ADD COLUMN IF NOT EXISTS token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS missing_fields   jsonb;

-- Fast look-up by token (for the applicant update page)
CREATE INDEX IF NOT EXISTS creator_applications_update_token_idx
  ON creator_applications(update_token)
  WHERE update_token IS NOT NULL;
