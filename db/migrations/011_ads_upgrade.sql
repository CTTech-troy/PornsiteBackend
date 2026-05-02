-- Extend ad_campaigns with creative fields required for the full ads system.
-- This migration is additive (IF NOT EXISTS guards) — safe to run on existing data.

ALTER TABLE ad_campaigns
  ADD COLUMN IF NOT EXISTS image_url       TEXT,
  ADD COLUMN IF NOT EXISTS redirect_url    TEXT,
  ADD COLUMN IF NOT EXISTS cta_text        TEXT    DEFAULT 'Learn More',
  ADD COLUMN IF NOT EXISTS placement       TEXT    DEFAULT 'homepage_banner',
  ADD COLUMN IF NOT EXISTS image_width     INTEGER,
  ADD COLUMN IF NOT EXISTS image_height    INTEGER,
  ADD COLUMN IF NOT EXISTS is_active       BOOLEAN NOT NULL DEFAULT TRUE;

-- Placement values: homepage_banner | sidebar | video_player | creator_profile | feed
-- Add check constraint for valid placements
ALTER TABLE ad_campaigns
  DROP CONSTRAINT IF EXISTS ad_campaigns_placement_check;

ALTER TABLE ad_campaigns
  ADD CONSTRAINT ad_campaigns_placement_check
  CHECK (placement IN ('homepage_banner','sidebar','video_player','creator_profile','feed'));

-- Index to quickly fetch active ads by placement (used by the frontend ad renderer)
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_placement_active
  ON ad_campaigns (placement, is_active)
  WHERE is_active = TRUE;

-- Keep existing status in sync with is_active on write — handled in application code.
-- Existing rows: set is_active based on current status field
UPDATE ad_campaigns
  SET is_active = (status = 'active')
  WHERE is_active IS NULL OR is_active = TRUE;
