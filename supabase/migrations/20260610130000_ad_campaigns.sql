-- First-party ad campaigns (admin portal: Ads Management + Sidebar Ads)

CREATE TABLE IF NOT EXISTS public.ad_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  title text,
  description text,
  budget_usd numeric(14, 2) NOT NULL DEFAULT 0,
  cpc numeric(10, 4) NOT NULL DEFAULT 0,
  impressions bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0,
  revenue_usd numeric(14, 4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('active', 'paused', 'ended', 'pending')),
  is_active boolean NOT NULL DEFAULT false,
  placement text NOT NULL DEFAULT 'homepage_banner'
    CHECK (placement IN ('homepage_banner', 'sidebar', 'video_player', 'creator_profile', 'feed')),
  image_url text,
  redirect_url text,
  click_url text,
  cta_text text NOT NULL DEFAULT 'Learn More',
  image_width int,
  image_height int,
  creative_type text NOT NULL DEFAULT 'image',
  embed_sanitized_html text,
  embed_html text,
  priority int NOT NULL DEFAULT 100,
  start_date timestamptz,
  end_date timestamptz,
  expiry_date timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ad_campaigns_placement_status
  ON public.ad_campaigns (placement, status, is_active);

CREATE INDEX IF NOT EXISTS idx_ad_campaigns_priority_created
  ON public.ad_campaigns (priority DESC, created_at DESC);

COMMENT ON TABLE public.ad_campaigns IS 'Admin-managed display ad campaigns (sidebar, banners, feed, etc.)';

-- Extend stat helper used by /api/ads/campaign/:id/impression|click
CREATE OR REPLACE FUNCTION public.increment_ad_stat(p_ad_id uuid, p_field text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_field = 'impressions' THEN
    UPDATE public.ad_campaigns
    SET impressions = COALESCE(impressions, 0) + 1, updated_at = now()
    WHERE id = p_ad_id;
    IF FOUND THEN RETURN; END IF;
    UPDATE public.video_ads
    SET impressions = COALESCE(impressions, 0) + 1
    WHERE id = p_ad_id;
  ELSIF p_field = 'clicks' THEN
    UPDATE public.ad_campaigns
    SET clicks = COALESCE(clicks, 0) + 1, updated_at = now()
    WHERE id = p_ad_id;
    IF FOUND THEN RETURN; END IF;
    UPDATE public.video_ads
    SET clicks = COALESCE(clicks, 0) + 1
    WHERE id = p_ad_id;
  END IF;
END;
$$;
