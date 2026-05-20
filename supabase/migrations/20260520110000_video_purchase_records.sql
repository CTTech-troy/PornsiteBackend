-- Premium video purchase records for creator-published and merged public videos.
-- Safe to run multiple times on databases that missed the earlier purchase table migration.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.video_purchases (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      text        NOT NULL,
  video_id     uuid        NOT NULL REFERENCES public.tiktok_videos(video_id) ON DELETE CASCADE,
  token_price  integer     NOT NULL DEFAULT 0,
  purchased_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, video_id)
);

ALTER TABLE IF EXISTS public.video_purchases
  ADD COLUMN IF NOT EXISTS token_price integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS purchased_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_video_purchases_user_id
  ON public.video_purchases(user_id);

CREATE TABLE IF NOT EXISTS public.public_video_purchases (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         text        NOT NULL,
  public_video_id text        NOT NULL,
  video_source    text        NOT NULL DEFAULT 'public',
  creator_id      text,
  token_price     integer     NOT NULL DEFAULT 0,
  metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  purchased_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, public_video_id)
);

CREATE INDEX IF NOT EXISTS idx_public_video_purchases_user_id
  ON public.public_video_purchases(user_id);

CREATE INDEX IF NOT EXISTS idx_public_video_purchases_public_video_id
  ON public.public_video_purchases(public_video_id);
