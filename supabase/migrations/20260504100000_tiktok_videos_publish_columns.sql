-- Publish / feed columns for tiktok_videos (required by videoPublish.getPublicVideos and uploads).
-- Idempotent: safe if some columns already exist.

ALTER TABLE IF EXISTS public.tiktok_videos
  ADD COLUMN IF NOT EXISTS is_live                 boolean  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_premium_content      boolean  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_people_to_comment boolean  NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS tags                    text[]   NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS main_orientation_category text,
  ADD COLUMN IF NOT EXISTS creator_display_name    text,
  ADD COLUMN IF NOT EXISTS creator_avatar_url      text,
  ADD COLUMN IF NOT EXISTS stream_url              text,
  ADD COLUMN IF NOT EXISTS token_price             integer  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS consent_given           boolean  NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_tiktok_videos_is_live
  ON public.tiktok_videos(is_live) WHERE is_live = true;
CREATE INDEX IF NOT EXISTS idx_tiktok_videos_user_is_live
  ON public.tiktok_videos(user_id, is_live);
