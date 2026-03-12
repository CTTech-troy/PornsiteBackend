-- 005_tiktok_videos.sql
-- TikTok-style video system: metadata and counters in Supabase; Firebase Auth only for user_id.
--
-- Run this in Supabase Dashboard → SQL Editor (or your migration runner).
-- Ensure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set in backend .env.
-- Storage bucket: use existing VIDEO_BUCKET (e.g. "videos"); uploads go to tiktok/{user_id}/...

-- Videos: metadata + storage URL + counters
CREATE TABLE IF NOT EXISTS tiktok_videos (
  video_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  storage_url text NOT NULL,
  title text NOT NULL DEFAULT '',
  description text DEFAULT '',
  likes_count integer NOT NULL DEFAULT 0 CHECK (likes_count >= 0),
  views_count integer NOT NULL DEFAULT 0 CHECK (views_count >= 0),
  comments_count integer NOT NULL DEFAULT 0 CHECK (comments_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tiktok_videos_user_id ON tiktok_videos (user_id);
CREATE INDEX IF NOT EXISTS idx_tiktok_videos_created_at ON tiktok_videos (created_at DESC);

-- Likes: one per user per video
CREATE TABLE IF NOT EXISTS tiktok_video_likes (
  video_id uuid NOT NULL REFERENCES tiktok_videos (video_id) ON DELETE CASCADE,
  user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (video_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_tiktok_video_likes_video_id ON tiktok_video_likes (video_id);

-- Views: unique view per user or session (anonymous)
CREATE TABLE IF NOT EXISTS tiktok_video_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES tiktok_videos (video_id) ON DELETE CASCADE,
  user_id text,
  session_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tiktok_views_user_or_session CHECK (
    (user_id IS NOT NULL AND session_id IS NULL) OR
    (user_id IS NULL AND session_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tiktok_video_views_unique_user
  ON tiktok_video_views (video_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tiktok_video_views_unique_session
  ON tiktok_video_views (video_id, session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tiktok_video_views_video_id ON tiktok_video_views (video_id);

-- Comments
CREATE TABLE IF NOT EXISTS tiktok_video_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES tiktok_videos (video_id) ON DELETE CASCADE,
  user_id text NOT NULL,
  comment text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tiktok_video_comments_video_id ON tiktok_video_comments (video_id);

COMMENT ON TABLE tiktok_videos IS 'TikTok-style video metadata; storage_url points to Supabase Storage.';
COMMENT ON TABLE tiktok_video_likes IS 'One like per user per video.';
COMMENT ON TABLE tiktok_video_views IS 'One view per user or per anonymous session per video.';
COMMENT ON TABLE tiktok_video_comments IS 'Comments on videos; user_id is Firebase UID.';
