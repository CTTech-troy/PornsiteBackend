-- 011_ads_upgrade (full): ad_campaigns + ad_impressions + ad_clicks + ad_payments
-- Run via Supabase CLI or paste into SQL Editor. Idempotent.

CREATE TABLE IF NOT EXISTS public.ad_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text,
  name text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  description text,
  image_url text,
  redirect_url text NOT NULL DEFAULT '',
  cta_text text NOT NULL DEFAULT 'Learn More',
  placement text NOT NULL DEFAULT 'homepage_banner',
  budget numeric(14,4) NOT NULL DEFAULT 0,
  cpc numeric(14,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  impressions bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0,
  start_date timestamptz,
  expiry_date timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  type text NOT NULL DEFAULT 'image',
  creative_type text NOT NULL DEFAULT 'image',
  embed_html text,
  embed_sanitized_html text,
  script_fingerprint text,
  video_url text,
  click_url text,
  device text NOT NULL DEFAULT 'all',
  priority integer NOT NULL DEFAULT 1,
  revenue_usd numeric(14,4) NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT false
);

ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS user_id text;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT '';
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '';
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS image_url text;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS redirect_url text NOT NULL DEFAULT '';
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS cta_text text NOT NULL DEFAULT 'Learn More';
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS placement text NOT NULL DEFAULT 'homepage_banner';
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS budget numeric(14,4) NOT NULL DEFAULT 0;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS cpc numeric(14,4) NOT NULL DEFAULT 0;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending';
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS impressions bigint NOT NULL DEFAULT 0;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS clicks bigint NOT NULL DEFAULT 0;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS start_date timestamptz;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS expiry_date timestamptz;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'image';
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS creative_type text NOT NULL DEFAULT 'image';
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS embed_html text;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS embed_sanitized_html text;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS script_fingerprint text;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS video_url text;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS click_url text;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS device text NOT NULL DEFAULT 'all';
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 1;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS revenue_usd numeric(14,4) NOT NULL DEFAULT 0;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT false;

ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS budget_usd numeric(14,4);
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS end_date timestamptz;

UPDATE public.ad_campaigns
SET budget = COALESCE(NULLIF(budget, 0), budget_usd, 0)
WHERE budget_usd IS NOT NULL AND (budget IS NULL OR budget = 0);

UPDATE public.ad_campaigns
SET expiry_date = COALESCE(expiry_date, end_date)
WHERE end_date IS NOT NULL AND expiry_date IS NULL;

UPDATE public.ad_campaigns
SET status = CASE
  WHEN COALESCE(is_active, false) THEN 'active'
  ELSE 'pending'
END
WHERE status IS NULL;

UPDATE public.ad_campaigns
SET is_active = (status = 'active')
WHERE true;

ALTER TABLE public.ad_campaigns DROP CONSTRAINT IF EXISTS ad_campaigns_status_check;
ALTER TABLE public.ad_campaigns
  ADD CONSTRAINT ad_campaigns_status_check
  CHECK (status IN ('pending', 'active', 'paused', 'rejected', 'expired'));

ALTER TABLE public.ad_campaigns DROP CONSTRAINT IF EXISTS ad_campaigns_placement_check;
ALTER TABLE public.ad_campaigns
  ADD CONSTRAINT ad_campaigns_placement_check
  CHECK (
    placement IN (
      'homepage_banner',
      'sidebar',
      'video_player',
      'creator_profile',
      'feed',
      'trending',
      'premium'
    )
  );

CREATE OR REPLACE FUNCTION public.ad_campaigns_set_active_flag()
RETURNS TRIGGER AS $$
BEGIN
  NEW.is_active := (NEW.status = 'active');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ad_campaigns_set_active_flag_tg ON public.ad_campaigns;
CREATE TRIGGER ad_campaigns_set_active_flag_tg
BEFORE INSERT OR UPDATE ON public.ad_campaigns
FOR EACH ROW
EXECUTE PROCEDURE public.ad_campaigns_set_active_flag();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'users'
  ) THEN
    ALTER TABLE public.ad_campaigns DROP CONSTRAINT IF EXISTS ad_campaigns_user_id_fkey;
    ALTER TABLE public.ad_campaigns
      ADD CONSTRAINT ad_campaigns_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES public.users (id) ON DELETE SET NULL;
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'ad_campaigns.user_id FK skipped: %', SQLERRM;
END $$;

CREATE INDEX IF NOT EXISTS idx_ad_campaigns_status ON public.ad_campaigns (status);
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_placement ON public.ad_campaigns (placement);
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_created_at ON public.ad_campaigns (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_user_id ON public.ad_campaigns (user_id);
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_placement_active
  ON public.ad_campaigns (placement, is_active)
  WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_impressions ON public.ad_campaigns (impressions ASC);

CREATE TABLE IF NOT EXISTS public.ad_impressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.ad_campaigns (id) ON DELETE CASCADE,
  user_id text,
  session_id text,
  placement text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ad_impressions_campaign ON public.ad_impressions (campaign_id);
CREATE INDEX IF NOT EXISTS idx_ad_impressions_created ON public.ad_impressions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ad_impressions_placement ON public.ad_impressions (placement);

CREATE TABLE IF NOT EXISTS public.ad_clicks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.ad_campaigns (id) ON DELETE CASCADE,
  user_id text,
  session_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ad_clicks_campaign ON public.ad_clicks (campaign_id);
CREATE INDEX IF NOT EXISTS idx_ad_clicks_created ON public.ad_clicks (created_at DESC);

CREATE TABLE IF NOT EXISTS public.ad_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.ad_campaigns (id) ON DELETE CASCADE,
  amount numeric(14,4) NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  status text NOT NULL DEFAULT 'pending',
  provider_ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ad_payments DROP CONSTRAINT IF EXISTS ad_payments_status_check;
ALTER TABLE public.ad_payments
  ADD CONSTRAINT ad_payments_status_check
  CHECK (status IN ('pending', 'completed', 'failed'));

CREATE INDEX IF NOT EXISTS idx_ad_payments_campaign ON public.ad_payments (campaign_id);
CREATE INDEX IF NOT EXISTS idx_ad_payments_status ON public.ad_payments (status);
CREATE INDEX IF NOT EXISTS idx_ad_payments_created ON public.ad_payments (created_at DESC);

ALTER TABLE public.ad_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ad_impressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ad_clicks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ad_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_read_active" ON public.ad_campaigns;
DROP POLICY IF EXISTS "service_role_all" ON public.ad_campaigns;
DROP POLICY IF EXISTS ad_campaigns_public_read_active ON public.ad_campaigns;
CREATE POLICY ad_campaigns_public_read_active
  ON public.ad_campaigns FOR SELECT
  TO anon, authenticated
  USING (
    status = 'active'
    AND (start_date IS NULL OR start_date <= now())
    AND (expiry_date IS NULL OR expiry_date >= now())
  );

DROP POLICY IF EXISTS ad_campaigns_owner_manage ON public.ad_campaigns;
CREATE POLICY ad_campaigns_owner_manage
  ON public.ad_campaigns FOR ALL
  TO authenticated
  USING (user_id IS NOT NULL AND user_id = (SELECT auth.uid()::text))
  WITH CHECK (user_id IS NOT NULL AND user_id = (SELECT auth.uid()::text));

DROP POLICY IF EXISTS ad_campaigns_admin_manage ON public.ad_campaigns;
CREATE POLICY ad_campaigns_admin_manage
  ON public.ad_campaigns FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = (SELECT auth.uid()::text)
      AND COALESCE(u.role, '') = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = (SELECT auth.uid()::text)
      AND COALESCE(u.role, '') = 'admin'
    )
  );
