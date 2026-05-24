-- Creator leaderboard controls, settings, and optimized ranking RPC.
-- Ranking is driven primarily by public, approved/published, active video count.

CREATE TABLE IF NOT EXISTS public.creator_leaderboard_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  video_count_weight numeric NOT NULL DEFAULT 100,
  engagement_weight numeric NOT NULL DEFAULT 10,
  views_weight numeric NOT NULL DEFAULT 1,
  recent_activity_weight numeric NOT NULL DEFAULT 5,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.creator_leaderboard_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.creator_leaderboard_controls (
  creator_id text PRIMARY KEY,
  excluded boolean NOT NULL DEFAULT false,
  suspended boolean NOT NULL DEFAULT false,
  pinned_rank integer,
  manual_rank integer,
  note text,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT creator_leaderboard_controls_pinned_rank_positive CHECK (pinned_rank IS NULL OR pinned_rank > 0),
  CONSTRAINT creator_leaderboard_controls_manual_rank_positive CHECK (manual_rank IS NULL OR manual_rank > 0)
);

CREATE OR REPLACE FUNCTION public.touch_creator_leaderboard_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_creator_leaderboard_settings_updated_at ON public.creator_leaderboard_settings;
CREATE TRIGGER trg_creator_leaderboard_settings_updated_at
BEFORE UPDATE ON public.creator_leaderboard_settings
FOR EACH ROW
EXECUTE FUNCTION public.touch_creator_leaderboard_updated_at();

DROP TRIGGER IF EXISTS trg_creator_leaderboard_controls_updated_at ON public.creator_leaderboard_controls;
CREATE TRIGGER trg_creator_leaderboard_controls_updated_at
BEFORE UPDATE ON public.creator_leaderboard_controls
FOR EACH ROW
EXECUTE FUNCTION public.touch_creator_leaderboard_updated_at();

CREATE INDEX IF NOT EXISTS idx_creator_leaderboard_controls_rank
  ON public.creator_leaderboard_controls (excluded, suspended, pinned_rank, manual_rank);

CREATE INDEX IF NOT EXISTS idx_creators_leaderboard_active
  ON public.creators (user_id, active, status);

CREATE INDEX IF NOT EXISTS idx_tiktok_videos_creator_leaderboard_public
  ON public.tiktok_videos (user_id, status, visibility, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tiktok_videos_creator_published_count
  ON public.tiktok_videos (user_id, created_at DESC)
  WHERE deleted_at IS NULL
    AND visibility = 'public'
    AND (is_live = true OR status IN ('published', 'approved', 'active'));

CREATE OR REPLACE FUNCTION public.get_creator_leaderboard(
  p_limit integer DEFAULT 10,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  rank_position integer,
  creator_id text,
  creator_row_id text,
  display_name text,
  username text,
  avatar_url text,
  verified boolean,
  creator_type text,
  published_video_count bigint,
  total_views bigint,
  total_likes bigint,
  total_comments bigint,
  follower_count bigint,
  total_watch_time_seconds bigint,
  revenue_earned numeric,
  average_engagement_rate numeric,
  engagement_score numeric,
  last_activity_at timestamptz,
  pinned_rank integer,
  manual_rank integer,
  is_featured boolean,
  total_count bigint
)
LANGUAGE sql
STABLE
AS $$
WITH safe_args AS (
  SELECT
    LEAST(GREATEST(COALESCE(p_limit, 10), 1), 100) AS safe_limit,
    GREATEST(COALESCE(p_offset, 0), 0) AS safe_offset
),
settings AS (
  SELECT
    COALESCE(MAX(video_count_weight) FILTER (WHERE id = 1), 100)::numeric AS video_count_weight,
    COALESCE(MAX(engagement_weight) FILTER (WHERE id = 1), 10)::numeric AS engagement_weight,
    COALESCE(MAX(views_weight) FILTER (WHERE id = 1), 1)::numeric AS views_weight,
    COALESCE(MAX(recent_activity_weight) FILTER (WHERE id = 1), 5)::numeric AS recent_activity_weight
  FROM public.creator_leaderboard_settings
),
eligible_videos AS (
  SELECT
    v.user_id::text AS user_id,
    COALESCE(v.views_count, 0)::bigint AS views_count,
    COALESCE(v.likes_count, 0)::bigint AS likes_count,
    COALESCE(v.comments_count, 0)::bigint AS comments_count,
    GREATEST(COALESCE(v.duration_seconds, 0), 0)::bigint AS duration_seconds,
    v.created_at
  FROM public.tiktok_videos v
  WHERE v.user_id IS NOT NULL
    AND v.deleted_at IS NULL
    AND COALESCE(v.visibility, 'public') = 'public'
    AND (COALESCE(v.is_live, false) = true OR COALESCE(v.status, 'published') IN ('published', 'approved', 'active'))
    AND LOWER(COALESCE(v.status, 'published')) NOT IN ('draft', 'deleted', 'suspended', 'rejected', 'archived', 'removed')
),
video_stats AS (
  SELECT
    user_id,
    COUNT(*)::bigint AS published_video_count,
    SUM(views_count)::bigint AS total_views,
    SUM(likes_count)::bigint AS total_likes,
    SUM(comments_count)::bigint AS total_comments,
    SUM((duration_seconds * views_count))::bigint AS total_watch_time_seconds,
    MAX(created_at) AS last_activity_at,
    (SUM(likes_count) * 3 + SUM(comments_count) * 5 + SUM(views_count))::numeric AS engagement_score,
    CASE
      WHEN SUM(views_count) > 0 THEN ROUND(((SUM(likes_count) + SUM(comments_count))::numeric / NULLIF(SUM(views_count), 0)) * 100, 4)
      ELSE 0::numeric
    END AS average_engagement_rate
  FROM eligible_videos
  GROUP BY user_id
),
creator_rows AS (
  SELECT
    c.id::text AS creator_row_id,
    c.user_id::text AS creator_id,
    to_jsonb(c) AS creator_json
  FROM public.creators c
  WHERE c.user_id IS NOT NULL
    AND COALESCE(NULLIF(to_jsonb(c)->>'active', '')::boolean, true) = true
    AND LOWER(COALESCE(NULLIF(to_jsonb(c)->>'status', ''), 'active')) NOT IN ('banned', 'suspended', 'removed', 'deleted', 'archived')
),
eligible_creators AS (
  SELECT
    cr.creator_id,
    cr.creator_row_id,
    cr.creator_json,
    to_jsonb(u) AS user_json,
    vs.published_video_count,
    vs.total_views,
    vs.total_likes,
    vs.total_comments,
    vs.total_watch_time_seconds,
    vs.average_engagement_rate,
    vs.engagement_score,
    vs.last_activity_at,
    clc.pinned_rank,
    clc.manual_rank
  FROM creator_rows cr
  JOIN video_stats vs ON vs.user_id = cr.creator_id
  LEFT JOIN public.users u ON u.id::text = cr.creator_id
  LEFT JOIN public.creator_leaderboard_controls clc ON clc.creator_id = cr.creator_id
  WHERE COALESCE(clc.excluded, false) = false
    AND COALESCE(clc.suspended, false) = false
    AND COALESCE(NULLIF(to_jsonb(u)->>'banned', '')::boolean, false) = false
    AND COALESCE(NULLIF(to_jsonb(u)->>'suspended', '')::boolean, false) = false
),
decorated AS (
  SELECT
    ec.*,
    COALESCE(
      NULLIF(ec.creator_json->>'display_name', ''),
      NULLIF(ec.user_json->>'display_name', ''),
      NULLIF(ec.user_json->>'full_name', ''),
      NULLIF(ec.user_json->>'username', ''),
      'Creator'
    ) AS resolved_display_name,
    COALESCE(NULLIF(ec.user_json->>'username', ''), ec.creator_id) AS resolved_username,
    COALESCE(NULLIF(ec.user_json->>'avatar_url', ''), NULLIF(ec.user_json->>'avatar', '')) AS resolved_avatar_url,
    CASE
      WHEN LOWER(COALESCE(ec.user_json->>'verified', ec.user_json->>'creator_status', '')) IN ('true', 'approved', 'verified') THEN true
      WHEN LOWER(COALESCE(ec.user_json->>'is_verified', ec.user_json->>'email_verified', '')) = 'true' THEN true
      ELSE false
    END AS resolved_verified,
    COALESCE(NULLIF(ec.creator_json->>'creator_type', ''), 'pstar') AS resolved_creator_type,
    CASE
      WHEN COALESCE(ec.user_json->>'followers', '') ~ '^[0-9]+$' THEN (ec.user_json->>'followers')::bigint
      ELSE 0::bigint
    END AS resolved_follower_count,
    (
      (ec.published_video_count * settings.video_count_weight) +
      (ec.engagement_score * settings.engagement_weight) +
      (ec.total_views * settings.views_weight) +
      (
        GREATEST(
          0,
          365 - COALESCE(EXTRACT(EPOCH FROM (now() - ec.last_activity_at)) / 86400, 365)
        ) * settings.recent_activity_weight
      )
    ) AS weighted_score
  FROM eligible_creators ec
  CROSS JOIN settings
),
ranked AS (
  SELECT
    ROW_NUMBER() OVER (
      ORDER BY
        CASE WHEN pinned_rank IS NOT NULL THEN 0 WHEN manual_rank IS NOT NULL THEN 1 ELSE 2 END ASC,
        COALESCE(pinned_rank, manual_rank, 2147483647) ASC,
        published_video_count DESC,
        weighted_score DESC,
        engagement_score DESC,
        total_views DESC,
        last_activity_at DESC NULLS LAST,
        resolved_display_name ASC
    )::integer AS rank_position,
    creator_id,
    creator_row_id,
    resolved_display_name AS display_name,
    resolved_username AS username,
    resolved_avatar_url AS avatar_url,
    resolved_verified AS verified,
    resolved_creator_type AS creator_type,
    published_video_count,
    total_views,
    total_likes,
    total_comments,
    resolved_follower_count AS follower_count,
    total_watch_time_seconds,
    0::numeric AS revenue_earned,
    average_engagement_rate,
    engagement_score,
    last_activity_at,
    pinned_rank,
    manual_rank,
    (pinned_rank IS NOT NULL) AS is_featured,
    COUNT(*) OVER ()::bigint AS total_count
  FROM decorated
)
SELECT ranked.*
FROM ranked, safe_args
ORDER BY rank_position ASC
LIMIT safe_args.safe_limit
OFFSET safe_args.safe_offset;
$$;
