-- Official company ownership for imported/system videos and richer premium access controls.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS is_system_account boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS protected_account boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS official_company boolean NOT NULL DEFAULT false;

ALTER TABLE public.creators
  ADD COLUMN IF NOT EXISTS is_system_account boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS protected_account boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS official_company boolean NOT NULL DEFAULT false;

ALTER TABLE public.tiktok_videos
  ADD COLUMN IF NOT EXISTS access_type text NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS premium_visibility text NOT NULL DEFAULT 'public_preview',
  ADD COLUMN IF NOT EXISTS requires_membership boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS subscription_access boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS monetization_owner_id text,
  ADD COLUMN IF NOT EXISTS official_company_content boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tiktok_videos_access_type_check'
  ) THEN
    ALTER TABLE public.tiktok_videos
      ADD CONSTRAINT tiktok_videos_access_type_check
      CHECK (access_type IN ('free', 'premium', 'members_only', 'coin_unlock'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tiktok_videos_premium_visibility_check'
  ) THEN
    ALTER TABLE public.tiktok_videos
      ADD CONSTRAINT tiktok_videos_premium_visibility_check
      CHECK (premium_visibility IN ('public', 'public_preview', 'members_only', 'hidden'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tiktok_videos_company_content
  ON public.tiktok_videos (official_company_content, content_source, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tiktok_videos_premium_access
  ON public.tiktok_videos (access_type, is_premium_content, token_price);
