-- Third-party ads management: providers, zones, monitoring, health diagnostics

CREATE TABLE IF NOT EXISTS ad_providers (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  provider_type text NOT NULL DEFAULT 'display' CHECK (provider_type IN ('display', 'vast', 'native', 'gam')),
  is_enabled boolean NOT NULL DEFAULT true,
  is_maintenance boolean NOT NULL DEFAULT false,
  priority int NOT NULL DEFAULT 100,
  script_url text,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  estimated_cpm_usd numeric(10,4) NOT NULL DEFAULT 0,
  skip_after_seconds int NOT NULL DEFAULT 5,
  skippable boolean NOT NULL DEFAULT true,
  ad_frequency int NOT NULL DEFAULT 3,
  retry_limit int NOT NULL DEFAULT 2,
  timeout_ms int NOT NULL DEFAULT 8000,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_health_status text NOT NULL DEFAULT 'unknown' CHECK (last_health_status IN ('healthy', 'degraded', 'failed', 'unknown')),
  impressions bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0,
  failed_requests bigint NOT NULL DEFAULT 0,
  revenue_usd numeric(14,4) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ad_zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id text NOT NULL REFERENCES ad_providers(id) ON DELETE CASCADE,
  placement text NOT NULL,
  zone_id text NOT NULL,
  tag_url text,
  width int,
  height int,
  is_active boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  impressions bigint NOT NULL DEFAULT 0,
  failed_loads bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, placement, zone_id)
);

CREATE TABLE IF NOT EXISTS ad_provider_health_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id text NOT NULL REFERENCES ad_providers(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('healthy', 'degraded', 'failed')),
  check_type text NOT NULL DEFAULT 'manual' CHECK (check_type IN ('manual', 'scheduled', 'auto_fallback')),
  response_ms int,
  error_code text,
  error_message text,
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ad_health_provider_created ON ad_provider_health_checks(provider_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ad_monitoring_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id text REFERENCES ad_providers(id) ON DELETE SET NULL,
  zone_id uuid REFERENCES ad_zones(id) ON DELETE SET NULL,
  session_id text,
  video_id text,
  user_id text,
  fingerprint text,
  event_type text NOT NULL,
  placement text,
  device_type text,
  browser text,
  country text,
  revenue_usd numeric(12,6) NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ad_monitoring_created ON ad_monitoring_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ad_monitoring_provider ON ad_monitoring_events(provider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ad_monitoring_session ON ad_monitoring_events(session_id);

CREATE TABLE IF NOT EXISTS ad_provider_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id text,
  admin_id text,
  admin_email text,
  action text NOT NULL,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ad_audit_created ON ad_provider_audit_log(created_at DESC);

INSERT INTO ad_providers (id, name, slug, provider_type, is_enabled, priority, script_url, config, estimated_cpm_usd, skip_after_seconds)
VALUES
  ('exoclick', 'ExoClick', 'exoclick', 'vast', true, 10, NULL, '{"network":"exoclick"}'::jsonb, 2.0000, 5),
  ('juicyads', 'JuicyAds', 'juicyads', 'display', true, 20, 'https://adserver.juicyads.com/js/jads.js', '{"queueKey":"adsbyjuicy"}'::jsonb, 1.5000, 5),
  ('monetag', 'Monetag', 'monetag', 'display', false, 30, NULL, '{"verificationOnly":true}'::jsonb, 1.2000, 5),
  ('google_ad_manager', 'Google Ad Manager', 'google_ad_manager', 'gam', false, 40, 'https://securepubads.g.doubleclick.net/tag/js/gpt.js', '{}'::jsonb, 3.0000, 5)
ON CONFLICT (id) DO NOTHING;

INSERT INTO ad_zones (provider_id, placement, zone_id, tag_url, width, height)
VALUES
  ('exoclick', 'video_preroll', '5932212', 'https://s.magsrv.com/v1/vast.php?idzone=5932212', NULL, NULL),
  ('juicyads', 'homepage_banner', '1117006', NULL, 468, 60),
  ('juicyads', 'leaderboard', '1117006', NULL, 728, 90),
  ('juicyads', 'sidebar', '1117006', NULL, 300, 250)
ON CONFLICT (provider_id, placement, zone_id) DO NOTHING;

INSERT INTO platform_settings (key, value, section, description, value_type)
VALUES
  ('ad_provider_priority_order', '["exoclick","juicyads","monetag","google_ad_manager"]', 'Monetization', 'Ordered list of ad provider slugs for fallback', 'json'),
  ('ad_auto_fallback_enabled', 'true', 'Monetization', 'Auto-switch to fallback provider on failure', 'toggle'),
  ('ad_health_scan_interval_minutes', '15', 'Monetization', 'Minutes between automated ad health scans', 'number'),
  ('juicyads_enabled', 'true', 'Monetization', 'Enable JuicyAds display network', 'toggle'),
  ('monetag_enabled', 'false', 'Monetization', 'Enable Monetag display network', 'toggle'),
  ('google_ad_manager_enabled', 'false', 'Monetization', 'Enable Google Ad Manager', 'toggle')
ON CONFLICT (key) DO NOTHING;
