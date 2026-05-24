-- Webmaster / Publisher Partner System

CREATE TABLE IF NOT EXISTS public.publisher_partners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL UNIQUE,
  partner_code text NOT NULL UNIQUE,
  company_name text,
  contact_email text,
  contact_name text,
  role_type text NOT NULL DEFAULT 'webmaster'
    CHECK (role_type IN ('webmaster', 'affiliate', 'advertiser')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'suspended', 'rejected')),
  approval_status text NOT NULL DEFAULT 'pending'
    CHECK (approval_status IN ('pending', 'limited', 'approved', 'rejected')),
  tier text NOT NULL DEFAULT 'standard',
  fraud_score numeric(5,2) NOT NULL DEFAULT 0,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  balance_usd numeric(12,4) NOT NULL DEFAULT 0,
  pending_usd numeric(12,4) NOT NULL DEFAULT 0,
  total_earned_usd numeric(12,4) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_publisher_partners_status ON public.publisher_partners(status);
CREATE INDEX IF NOT EXISTS idx_publisher_partners_code ON public.publisher_partners(partner_code);

CREATE TABLE IF NOT EXISTS public.publisher_websites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES public.publisher_partners(id) ON DELETE CASCADE,
  domain text NOT NULL,
  site_url text NOT NULL,
  category text,
  traffic_source text,
  description text,
  logo_url text,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_review', 'approved', 'rejected', 'suspended')),
  verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified', 'pending', 'verified', 'failed')),
  monthly_traffic_estimate integer,
  impressions bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0,
  revenue_usd numeric(12,4) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (partner_id, domain)
);

CREATE INDEX IF NOT EXISTS idx_publisher_websites_partner ON public.publisher_websites(partner_id);
CREATE INDEX IF NOT EXISTS idx_publisher_websites_domain ON public.publisher_websites(domain);

CREATE TABLE IF NOT EXISTS public.publisher_website_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  website_id uuid NOT NULL REFERENCES public.publisher_websites(id) ON DELETE CASCADE,
  method text NOT NULL DEFAULT 'meta'
    CHECK (method IN ('meta', 'dns_txt', 'html_file')),
  token text NOT NULL,
  verified_at timestamptz,
  last_scan_at timestamptz,
  scan_status text NOT NULL DEFAULT 'idle'
    CHECK (scan_status IN ('idle', 'scanning', 'passed', 'failed')),
  scan_log jsonb NOT NULL DEFAULT '[]'::jsonb,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_publisher_verifications_website ON public.publisher_website_verifications(website_id);

CREATE TABLE IF NOT EXISTS public.publisher_ad_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES public.publisher_partners(id) ON DELETE CASCADE,
  website_id uuid REFERENCES public.publisher_websites(id) ON DELETE SET NULL,
  name text NOT NULL,
  unit_type text NOT NULL DEFAULT 'banner'
    CHECK (unit_type IN ('banner', 'sidebar', 'native', 'popup', 'video', 'referral', 'smart_link')),
  size text NOT NULL DEFAULT '300x250',
  placement_hint text,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  impressions bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0,
  revenue_usd numeric(12,4) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_publisher_ad_units_partner ON public.publisher_ad_units(partner_id);

CREATE TABLE IF NOT EXISTS public.publisher_embed_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_unit_id uuid NOT NULL REFERENCES public.publisher_ad_units(id) ON DELETE CASCADE,
  public_token text NOT NULL UNIQUE,
  allowed_domains text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_publisher_embed_token ON public.publisher_embed_tokens(public_token);

CREATE TABLE IF NOT EXISTS public.publisher_ad_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL CHECK (event_type IN ('impression', 'click')),
  ad_unit_id uuid REFERENCES public.publisher_ad_units(id) ON DELETE SET NULL,
  partner_id uuid REFERENCES public.publisher_partners(id) ON DELETE SET NULL,
  token text,
  ip_hash text,
  device_fingerprint text,
  geo text,
  referrer text,
  user_agent text,
  is_valid boolean NOT NULL DEFAULT true,
  fraud_flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  revenue_usd numeric(12,6) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_publisher_ad_events_created ON public.publisher_ad_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_publisher_ad_events_partner ON public.publisher_ad_events(partner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.publisher_referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES public.publisher_partners(id) ON DELETE CASCADE,
  referral_type text NOT NULL CHECK (referral_type IN ('advertiser', 'creator', 'user')),
  target_user_id text,
  click_id text,
  landing_path text,
  converted_at timestamptz,
  commission_usd numeric(12,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_publisher_referrals_partner ON public.publisher_referrals(partner_id);

CREATE TABLE IF NOT EXISTS public.publisher_earnings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES public.publisher_partners(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('cpm', 'cpc', 'referral', 'bonus')),
  amount_usd numeric(12,4) NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'available', 'paid')),
  reference_id text,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_publisher_earnings_partner ON public.publisher_earnings(partner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.publisher_payout_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES public.publisher_partners(id) ON DELETE CASCADE,
  amount_usd numeric(12,4) NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'processing', 'paid', 'rejected', 'failed')),
  payout_method text,
  payout_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  admin_notes text,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_publisher_payouts_partner ON public.publisher_payout_requests(partner_id);

CREATE TABLE IF NOT EXISTS public.publisher_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid REFERENCES public.publisher_partners(id) ON DELETE SET NULL,
  website_id uuid REFERENCES public.publisher_websites(id) ON DELETE SET NULL,
  actor_id text,
  actor_email text,
  action text NOT NULL,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_publisher_audit_created ON public.publisher_audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS public.publisher_partner_inquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  company text,
  email text NOT NULL,
  website_url text,
  partnership_type text,
  country text,
  message text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'converted', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.platform_settings (key, value, section, description, value_type)
VALUES
  ('publisher_cpm_usd', '1.50', 'Publisher Partners', 'Default publisher CPM (USD)', 'number'),
  ('publisher_cpc_usd', '0.05', 'Publisher Partners', 'Default publisher CPC (USD)', 'number'),
  ('publisher_revenue_share_percent', '70', 'Publisher Partners', 'Publisher revenue share %', 'number'),
  ('publisher_referral_commission_percent', '10', 'Publisher Partners', 'Referral commission %', 'number'),
  ('publisher_fraud_threshold', '75', 'Publisher Partners', 'Fraud score block threshold', 'number'),
  ('publisher_min_payout_usd', '25', 'Publisher Partners', 'Minimum publisher payout (USD)', 'number')
ON CONFLICT (key) DO NOTHING;
