-- Creator ad reward (flat rate per valid view) — platform keeps 100% of provider revenue

ALTER TABLE public.vast_ad_sessions
  ADD COLUMN IF NOT EXISTS reward_credited boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS platform_gross_usd numeric(12, 6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS creator_reward_usd numeric(12, 6) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.creator_ad_valid_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.vast_ad_sessions(id) ON DELETE CASCADE,
  video_id text NOT NULL,
  creator_id text NOT NULL,
  user_id text,
  fingerprint text,
  viewer_key text NOT NULL,
  reward_usd numeric(12, 6) NOT NULL DEFAULT 0,
  platform_gross_usd numeric(12, 6) NOT NULL DEFAULT 0,
  validation_flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id)
);

CREATE INDEX IF NOT EXISTS idx_creator_ad_valid_views_creator
  ON public.creator_ad_valid_views (creator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_creator_ad_valid_views_viewer_day
  ON public.creator_ad_valid_views (viewer_key, created_at DESC);

CREATE TABLE IF NOT EXISTS public.platform_ad_revenue_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL DEFAULT 'vast_preroll',
  provider_slug text,
  gross_usd numeric(12, 6) NOT NULL DEFAULT 0,
  session_id uuid REFERENCES public.vast_ad_sessions(id) ON DELETE SET NULL,
  reference_id text UNIQUE,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_ad_revenue_ledger_created
  ON public.platform_ad_revenue_ledger (created_at DESC);

ALTER TABLE public.creator_earnings
  DROP CONSTRAINT IF EXISTS creator_earnings_source_check;

ALTER TABLE public.creator_earnings
  ADD CONSTRAINT creator_earnings_source_check
  CHECK (source IN (
    'live_gifts', 'video_views', 'purchase', 'premium_video',
    'ad', 'ad_impression', 'ad_reward', 'subscription', 'membership'
  ));

INSERT INTO public.platform_settings (key, value, section, description, value_type)
VALUES
  ('ad_creator_reward_per_1k_views', '0.60', 'Ad Reward Settings', 'Creator reward per 1,000 validated ad views (USD). Not revenue share.', 'number'),
  ('ad_valid_view_min_watch_sec', '5', 'Ad Reward Settings', 'Minimum seconds watched before skip counts as valid', 'number'),
  ('ad_reward_require_impression', 'true', 'Ad Reward Settings', 'Require a recorded impression before crediting reward', 'toggle'),
  ('ad_reward_fraud_protection', 'true', 'Ad Reward Settings', 'Enable fraud checks (daily caps, min watch time, replay)', 'toggle'),
  ('ad_reward_max_daily_per_viewer', '100', 'Ad Reward Settings', 'Max validated ad rewards per viewer per day', 'number'),
  ('ad_reward_min_complete_ms', '1000', 'Ad Reward Settings', 'Reject completes faster than this (bot protection)', 'number')
ON CONFLICT (key) DO NOTHING;

COMMENT ON TABLE public.creator_ad_valid_views IS 'Validated preroll ad views eligible for flat creator rewards';
COMMENT ON TABLE public.platform_ad_revenue_ledger IS 'Estimated gross ad revenue retained by platform (100% of provider payout)';
