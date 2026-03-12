-- 006_video_play_history_and_ads.sql
-- First-time ad playback: track per user/session whether they have seen the ad for a video.
-- Run in Supabase SQL Editor after 005_tiktok_videos.sql.

-- Play history: one row per (video_id, user_id) or (video_id, session_id)
CREATE TABLE IF NOT EXISTS video_play_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES tiktok_videos (video_id) ON DELETE CASCADE,
  user_id text,
  session_id text,
  has_seen_ad boolean NOT NULL DEFAULT false,
  played_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT play_history_user_or_session CHECK (
    (user_id IS NOT NULL AND session_id IS NULL) OR
    (user_id IS NULL AND session_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_video_play_history_unique_user
  ON video_play_history (video_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_video_play_history_unique_session
  ON video_play_history (video_id, session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_video_play_history_video_id ON video_play_history (video_id);

-- Ads: pre-defined ad videos for rotation (storage_url from Supabase or external)
CREATE TABLE IF NOT EXISTS video_ads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_url text NOT NULL,
  title text DEFAULT 'Ad',
  skip_after_seconds integer NOT NULL DEFAULT 5 CHECK (skip_after_seconds >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_video_ads_active ON video_ads (is_active) WHERE is_active = true;

-- Optional: ad impressions for analytics
CREATE TABLE IF NOT EXISTS video_ad_impressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_id uuid NOT NULL REFERENCES video_ads (id) ON DELETE CASCADE,
  video_id uuid NOT NULL REFERENCES tiktok_videos (video_id) ON DELETE CASCADE,
  user_id text,
  session_id text,
  skipped boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_video_ad_impressions_ad_id ON video_ad_impressions (ad_id);
CREATE INDEX IF NOT EXISTS idx_video_ad_impressions_created ON video_ad_impressions (created_at);

COMMENT ON TABLE video_play_history IS 'Tracks whether user/session has seen the first-time ad for a video.';
COMMENT ON TABLE video_ads IS 'Pre-defined ad videos; skip_after_seconds allows skippable ads.';
COMMENT ON TABLE video_ad_impressions IS 'Analytics: each time an ad is shown or skipped.';

-- Optional: insert a sample ad (use a public video URL; replace with your Supabase storage ad video URL)
-- INSERT INTO video_ads (storage_url, title, skip_after_seconds, is_active)
-- VALUES ('https://your-project.supabase.co/storage/v1/object/public/videos/ads/sample-ad.mp4', 'Sample Ad', 5, true);
