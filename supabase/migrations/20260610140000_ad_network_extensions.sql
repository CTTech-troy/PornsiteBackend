-- Ad network: multiple creatives, external platform links, partner distribution, paid publishing

ALTER TABLE public.ad_campaigns
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'image',
  ADD COLUMN IF NOT EXISTS external_platform text,
  ADD COLUMN IF NOT EXISTS network_visible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ownership text NOT NULL DEFAULT 'platform',
  ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES public.publisher_partners(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'waived',
  ADD COLUMN IF NOT EXISTS publish_fee_usd numeric(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paid_at timestamptz;

ALTER TABLE public.ad_campaigns DROP CONSTRAINT IF EXISTS ad_campaigns_source_type_check;
ALTER TABLE public.ad_campaigns ADD CONSTRAINT ad_campaigns_source_type_check
  CHECK (source_type IN ('image', 'external_link', 'embed'));

ALTER TABLE public.ad_campaigns DROP CONSTRAINT IF EXISTS ad_campaigns_ownership_check;
ALTER TABLE public.ad_campaigns ADD CONSTRAINT ad_campaigns_ownership_check
  CHECK (ownership IN ('platform', 'partner'));

ALTER TABLE public.ad_campaigns DROP CONSTRAINT IF EXISTS ad_campaigns_payment_status_check;
ALTER TABLE public.ad_campaigns ADD CONSTRAINT ad_campaigns_payment_status_check
  CHECK (payment_status IN ('waived', 'pending', 'paid', 'refunded'));

CREATE INDEX IF NOT EXISTS idx_ad_campaigns_network
  ON public.ad_campaigns (network_visible, status, payment_status)
  WHERE network_visible = true;

CREATE TABLE IF NOT EXISTS public.ad_network_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid REFERENCES public.ad_campaigns(id) ON DELETE CASCADE,
  partner_id uuid NOT NULL REFERENCES public.publisher_partners(id) ON DELETE CASCADE,
  order_type text NOT NULL CHECK (order_type IN ('run_on_network', 'publish_on_site')),
  amount_usd numeric(12, 2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'cancelled', 'refunded')),
  admin_notes text,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ad_network_orders_partner ON public.ad_network_orders(partner_id, status);

INSERT INTO public.platform_settings (key, value, section, description, value_type)
VALUES
  ('sidebar_min_active_ads', '3', 'Monetization', 'Minimum active sidebar ads before rotation (avoid same ad repeating)', 'number'),
  ('network_partner_run_ad_fee_usd', '49', 'Publisher Partners', 'Fee (USD) for partners to run their ad on the partner network', 'number'),
  ('network_partner_publish_fee_usd', '0', 'Publisher Partners', 'Fee (USD) for partners to publish paid ads on external sites via embed', 'number'),
  ('network_rotation_seconds', '90', 'Monetization', 'Seconds between sidebar ad rotations', 'number')
ON CONFLICT (key) DO NOTHING;
