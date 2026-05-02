-- Make Supabase the single source of truth for all app data.
-- Firebase RTDB is retained only for live-stream cache (syncs to Supabase on recovery).

-- ─── tiktok_videos: add publish/display columns ──────────────────────────────
ALTER TABLE IF EXISTS public.tiktok_videos
  ADD COLUMN IF NOT EXISTS is_live                boolean  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_premium_content     boolean  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_people_to_comment boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS tags                   text[]   NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS main_orientation_category text,
  ADD COLUMN IF NOT EXISTS creator_display_name   text,
  ADD COLUMN IF NOT EXISTS creator_avatar_url     text,
  ADD COLUMN IF NOT EXISTS stream_url             text,
  ADD COLUMN IF NOT EXISTS token_price            integer  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS consent_given          boolean  NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_tiktok_videos_is_live
  ON public.tiktok_videos(is_live) WHERE is_live = true;
CREATE INDEX IF NOT EXISTS idx_tiktok_videos_user_is_live
  ON public.tiktok_videos(user_id, is_live);

-- ─── tiktok_video_comments: add author name ──────────────────────────────────
ALTER TABLE IF EXISTS public.tiktok_video_comments
  ADD COLUMN IF NOT EXISTS author_name text;

-- ─── video_ads: add admin-CRUD and serving fields ────────────────────────────
ALTER TABLE IF EXISTS public.video_ads
  ADD COLUMN IF NOT EXISTS type             text    NOT NULL DEFAULT 'video',
  ADD COLUMN IF NOT EXISTS click_url        text,
  ADD COLUMN IF NOT EXISTS duration_seconds integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS categories       text[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS impressions      integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS clicks           integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS start_date       timestamptz,
  ADD COLUMN IF NOT EXISTS end_date         timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at       timestamptz NOT NULL DEFAULT now();

-- ─── membership_plans: add display-catalog fields ────────────────────────────
ALTER TABLE IF EXISTS public.membership_plans
  ADD COLUMN IF NOT EXISTS currency       text     NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS duration_label text,
  ADD COLUMN IF NOT EXISTS features       jsonb    NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS image_url      text,
  ADD COLUMN IF NOT EXISTS sort_order     integer  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at     timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at     timestamptz NOT NULL DEFAULT now();

-- ─── users: premium upload tracking + profile ────────────────────────────────
ALTER TABLE IF EXISTS public.users
  ADD COLUMN IF NOT EXISTS monthly_premium_uploads integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS premium_upload_month    text,
  ADD COLUMN IF NOT EXISTS display_name            text,
  ADD COLUMN IF NOT EXISTS avatar_url              text;

-- ─── conversations ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.conversations (
  id                     text        PRIMARY KEY,
  participant_ids        text[]      NOT NULL,
  creator_id             text        NOT NULL,
  last_message_text      text,
  last_message_at        timestamptz,
  last_message_sender_id text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_participants
  ON public.conversations USING GIN(participant_ids);
CREATE INDEX IF NOT EXISTS idx_conversations_updated
  ON public.conversations(updated_at DESC);

-- ─── messages ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.messages (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id text        NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_id       text        NOT NULL,
  receiver_id     text        NOT NULL,
  creator_id      text        NOT NULL,
  message_text    text        NOT NULL,
  read            boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON public.messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at      ON public.messages(created_at DESC);

-- ─── video_purchases ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.video_purchases (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      text        NOT NULL,
  video_id     uuid        NOT NULL REFERENCES public.tiktok_videos(video_id) ON DELETE CASCADE,
  token_price  integer     NOT NULL DEFAULT 0,
  purchased_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, video_id)
);

CREATE INDEX IF NOT EXISTS idx_video_purchases_user_id ON public.video_purchases(user_id);

-- ─── Atomic like/unlike RPCs ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.like_video(p_video_id uuid, p_user_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_count bigint;
BEGIN
  INSERT INTO tiktok_video_likes (video_id, user_id) VALUES (p_video_id, p_user_id)
  ON CONFLICT DO NOTHING;
  UPDATE tiktok_videos
    SET likes_count = (SELECT COUNT(*) FROM tiktok_video_likes WHERE video_id = p_video_id)
    WHERE video_id = p_video_id
  RETURNING likes_count INTO v_count;
  RETURN jsonb_build_object('liked', true, 'total_likes', COALESCE(v_count, 0));
END;
$$;

CREATE OR REPLACE FUNCTION public.unlike_video(p_video_id uuid, p_user_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_count bigint;
BEGIN
  DELETE FROM tiktok_video_likes WHERE video_id = p_video_id AND user_id = p_user_id;
  UPDATE tiktok_videos
    SET likes_count = (SELECT COUNT(*) FROM tiktok_video_likes WHERE video_id = p_video_id)
    WHERE video_id = p_video_id
  RETURNING likes_count INTO v_count;
  RETURN jsonb_build_object('liked', false, 'total_likes', COALESCE(v_count, 0));
END;
$$;

REVOKE ALL ON FUNCTION public.like_video(uuid, text)   FROM public;
REVOKE ALL ON FUNCTION public.unlike_video(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.like_video(uuid, text)   TO service_role;
GRANT EXECUTE ON FUNCTION public.unlike_video(uuid, text) TO service_role;

-- ─── Atomic view record RPC ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_video_view(p_video_id uuid, p_user_id text, p_session_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_dup   boolean := false;
  v_count bigint;
BEGIN
  IF p_user_id IS NOT NULL THEN
    SELECT EXISTS(SELECT 1 FROM tiktok_video_views WHERE video_id = p_video_id AND user_id = p_user_id) INTO v_dup;
  ELSE
    SELECT EXISTS(SELECT 1 FROM tiktok_video_views WHERE video_id = p_video_id AND session_id = p_session_id) INTO v_dup;
  END IF;

  IF NOT v_dup THEN
    IF p_user_id IS NOT NULL THEN
      INSERT INTO tiktok_video_views (video_id, user_id)     VALUES (p_video_id, p_user_id)     ON CONFLICT DO NOTHING;
    ELSE
      INSERT INTO tiktok_video_views (video_id, session_id)  VALUES (p_video_id, p_session_id)  ON CONFLICT DO NOTHING;
    END IF;
    UPDATE tiktok_videos
      SET views_count = (SELECT COUNT(*) FROM tiktok_video_views WHERE video_id = p_video_id)
      WHERE video_id = p_video_id
    RETURNING views_count INTO v_count;
  ELSE
    SELECT views_count INTO v_count FROM tiktok_videos WHERE video_id = p_video_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'views', COALESCE(v_count, 0), 'duplicate', v_dup);
END;
$$;

REVOKE ALL ON FUNCTION public.record_video_view(uuid, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.record_video_view(uuid, text, text) TO service_role;

-- ─── Ad stat increment RPC ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.increment_ad_stat(p_ad_id uuid, p_field text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF p_field = 'impressions' THEN
    UPDATE video_ads SET impressions = impressions + 1 WHERE id = p_ad_id;
  ELSIF p_field = 'clicks' THEN
    UPDATE video_ads SET clicks = clicks + 1 WHERE id = p_ad_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.increment_ad_stat(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.increment_ad_stat(uuid, text) TO service_role;
