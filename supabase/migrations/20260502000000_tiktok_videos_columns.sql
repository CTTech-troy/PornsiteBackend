-- Add missing columns to tiktok_videos for admin panel and premium content management
ALTER TABLE IF EXISTS tiktok_videos
  ADD COLUMN IF NOT EXISTS status        text    NOT NULL DEFAULT 'published',
  ADD COLUMN IF NOT EXISTS thumbnail_url text,
  ADD COLUMN IF NOT EXISTS coin_price    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS visibility   text    NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS earnings      numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reports_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS duration      integer;

-- Index for admin status filtering
CREATE INDEX IF NOT EXISTS tiktok_videos_status_idx ON tiktok_videos(status);
CREATE INDEX IF NOT EXISTS tiktok_videos_coin_price_idx ON tiktok_videos(coin_price);
