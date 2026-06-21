-- Repairs older Supabase deployments where ad_campaigns exists but is missing
-- newer admin-controlled placement columns used by the current backend.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.ad_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT '',
  title text,
  description text,
  budget_usd numeric(14, 2) NOT NULL DEFAULT 0,
  budget numeric(14, 4) NOT NULL DEFAULT 0,
  cpc numeric(14, 4) NOT NULL DEFAULT 0,
  impressions bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0,
  revenue_usd numeric(14, 4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  is_active boolean NOT NULL DEFAULT false,
  placement text NOT NULL DEFAULT 'homepage_banner',
  placement_type text,
  slot_key text,
  ad_size text,
  device_target text NOT NULL DEFAULT 'all',
  priority integer NOT NULL DEFAULT 100,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  render_failures bigint NOT NULL DEFAULT 0,
  image_url text,
  redirect_url text,
  click_url text,
  cta_text text NOT NULL DEFAULT 'Learn More',
  image_width integer,
  image_height integer,
  creative_type text NOT NULL DEFAULT 'image',
  source_type text NOT NULL DEFAULT 'image',
  external_platform text,
  embed_html text,
  embed_sanitized_html text,
  script_fingerprint text,
  network_visible boolean NOT NULL DEFAULT false,
  ownership text NOT NULL DEFAULT 'platform',
  payment_status text NOT NULL DEFAULT 'waived',
  start_date timestamptz,
  end_date timestamptz,
  expiry_date timestamptz,
  created_by uuid,
  user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ad_campaigns
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS budget_usd numeric(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS budget numeric(14, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS click_url text,
  ADD COLUMN IF NOT EXISTS image_width integer,
  ADD COLUMN IF NOT EXISTS image_height integer,
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'image',
  ADD COLUMN IF NOT EXISTS external_platform text,
  ADD COLUMN IF NOT EXISTS network_visible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ownership text NOT NULL DEFAULT 'platform',
  ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'waived',
  ADD COLUMN IF NOT EXISTS slot_key text,
  ADD COLUMN IF NOT EXISTS placement_type text,
  ADD COLUMN IF NOT EXISTS ad_size text,
  ADD COLUMN IF NOT EXISTS device_target text NOT NULL DEFAULT 'all',
  ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS render_failures bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS script_fingerprint text,
  ADD COLUMN IF NOT EXISTS end_date timestamptz,
  ADD COLUMN IF NOT EXISTS expiry_date timestamptz,
  ADD COLUMN IF NOT EXISTS created_by uuid,
  ADD COLUMN IF NOT EXISTS user_id text;

UPDATE public.ad_campaigns
SET
  budget_usd = COALESCE(budget_usd, budget, 0),
  budget = COALESCE(budget, budget_usd, 0),
  placement_type = COALESCE(placement_type, placement),
  device_target = COALESCE(device_target, 'all'),
  metadata = COALESCE(metadata, '{}'::jsonb),
  source_type = COALESCE(source_type, creative_type, 'image'),
  ownership = COALESCE(ownership, 'platform'),
  payment_status = COALESCE(payment_status, 'waived'),
  end_date = COALESCE(end_date, expiry_date),
  updated_at = COALESCE(updated_at, now());

ALTER TABLE public.ad_campaigns DROP CONSTRAINT IF EXISTS ad_campaigns_status_check;
ALTER TABLE public.ad_campaigns
  ADD CONSTRAINT ad_campaigns_status_check
  CHECK (status IN ('active', 'paused', 'ended', 'pending', 'rejected', 'expired'));

ALTER TABLE public.ad_campaigns DROP CONSTRAINT IF EXISTS ad_campaigns_placement_check;
ALTER TABLE public.ad_campaigns
  ADD CONSTRAINT ad_campaigns_placement_check
  CHECK (placement IN (
    'homepage_banner',
    'homepage_top',
    'homepage_bottom',
    'sidebar',
    'feed',
    'feed_native',
    'mobile_inline',
    'category_feed',
    'video_page',
    'sticky_banner',
    'native_card',
    'before_footer',
    'video_player',
    'creator_profile'
  ));

ALTER TABLE public.ad_campaigns DROP CONSTRAINT IF EXISTS ad_campaigns_source_type_check;
ALTER TABLE public.ad_campaigns
  ADD CONSTRAINT ad_campaigns_source_type_check
  CHECK (source_type IN ('image', 'external_link', 'embed'));

ALTER TABLE public.ad_campaigns DROP CONSTRAINT IF EXISTS ad_campaigns_ownership_check;
ALTER TABLE public.ad_campaigns
  ADD CONSTRAINT ad_campaigns_ownership_check
  CHECK (ownership IN ('platform', 'partner'));

ALTER TABLE public.ad_campaigns DROP CONSTRAINT IF EXISTS ad_campaigns_payment_status_check;
ALTER TABLE public.ad_campaigns
  ADD CONSTRAINT ad_campaigns_payment_status_check
  CHECK (payment_status IN ('waived', 'pending', 'paid', 'refunded'));

CREATE INDEX IF NOT EXISTS idx_ad_campaigns_placement_status
  ON public.ad_campaigns (placement, status, is_active);

CREATE INDEX IF NOT EXISTS idx_ad_campaigns_priority_created
  ON public.ad_campaigns (priority DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ad_campaigns_slot_key
  ON public.ad_campaigns (slot_key)
  WHERE slot_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ad_campaigns_device_target
  ON public.ad_campaigns (device_target, placement, status, is_active);

CREATE OR REPLACE FUNCTION public.notify_pgrst_reload_schema()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NOTIFY pgrst, 'reload schema';
END;
$$;

REVOKE ALL ON FUNCTION public.notify_pgrst_reload_schema() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_pgrst_reload_schema() TO service_role;

SELECT public.notify_pgrst_reload_schema();
