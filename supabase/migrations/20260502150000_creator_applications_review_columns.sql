-- Add review/decision columns to creator_applications
-- These are needed by updateApplicationStatus in adminUsers.controller.js

ALTER TABLE IF EXISTS creator_applications
  ADD COLUMN IF NOT EXISTS review_reason text,
  ADD COLUMN IF NOT EXISTS reviewed_at   timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by   text;

CREATE INDEX IF NOT EXISTS creator_applications_reviewed_at_idx
  ON creator_applications(reviewed_at)
  WHERE reviewed_at IS NOT NULL;
