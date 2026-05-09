-- Third-party ad embeds + scheduling + device targeting for ad_campaigns.
-- Additive migration; safe to run multiple times.

ALTER TABLE IF EXISTS public.ad_campaigns
  ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS device text NOT NULL DEFAULT 'desktop',
  ADD COLUMN IF NOT EXISTS start_date timestamptz,
  ADD COLUMN IF NOT EXISTS end_date timestamptz,
  ADD COLUMN IF NOT EXISTS creative_type text NOT NULL DEFAULT 'image',
  ADD COLUMN IF NOT EXISTS embed_html text,
  ADD COLUMN IF NOT EXISTS embed_sanitized_html text,
  ADD COLUMN IF NOT EXISTS script_fingerprint text;

-- Allowlist for device and creative_type
ALTER TABLE IF EXISTS public.ad_campaigns
  DROP CONSTRAINT IF EXISTS ad_campaigns_device_check;
ALTER TABLE IF EXISTS public.ad_campaigns
  ADD CONSTRAINT ad_campaigns_device_check
  CHECK (device IN ('desktop', 'mobile', 'all'));

ALTER TABLE IF EXISTS public.ad_campaigns
  DROP CONSTRAINT IF EXISTS ad_campaigns_creative_type_check;
ALTER TABLE IF EXISTS public.ad_campaigns
  ADD CONSTRAINT ad_campaigns_creative_type_check
  CHECK (creative_type IN ('image', 'video', 'embed', 'script', 'iframe', 'html'));

-- Indexes for serving
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_placement_active_device
  ON public.ad_campaigns (placement, is_active, device);

CREATE INDEX IF NOT EXISTS idx_ad_campaigns_active_schedule
  ON public.ad_campaigns (is_active, start_date, end_date);

CREATE INDEX IF NOT EXISTS idx_ad_campaigns_priority
  ON public.ad_campaigns (priority DESC);

