-- Explicit creator relationship for public videos.
-- Existing rows used user_id as the creator owner; keep that truth and mirror it
-- into creator_id so profile lookups can use either column.

ALTER TABLE public.tiktok_videos
  ADD COLUMN IF NOT EXISTS creator_id text;

UPDATE public.tiktok_videos
SET creator_id = user_id
WHERE creator_id IS NULL
  AND user_id IS NOT NULL;

ALTER TABLE public.tiktok_videos
  ALTER COLUMN creator_id SET DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_tiktok_videos_creator_id
  ON public.tiktok_videos (creator_id);

CREATE INDEX IF NOT EXISTS idx_tiktok_videos_creator_created
  ON public.tiktok_videos (creator_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tiktok_videos_user_created
  ON public.tiktok_videos (user_id, created_at DESC);

DO $$
BEGIN
  IF to_regclass('public.media') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_media_creator_created
      ON public.media (user_id, created_at DESC)
      WHERE type = 'video';
  END IF;
END $$;
