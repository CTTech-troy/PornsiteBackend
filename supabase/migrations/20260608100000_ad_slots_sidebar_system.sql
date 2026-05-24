-- Sidebar ad slots + JuicyAds v3 300x250 configuration

UPDATE ad_providers
SET
  script_url = 'https://poweredby.jads.co/js/jads.js',
  config = jsonb_build_object(
    'queueKey', 'adsbyjuicy',
    'scriptUrl', 'https://poweredby.jads.co/js/jads.js',
    'defaultZoneId', '1118510',
    'defaultWidth', 300,
    'defaultHeight', 250,
    'embedTemplate', '<ins id="{zoneId}" data-width="{width}" data-height="{height}"></ins>'
  ),
  updated_at = now()
WHERE id = 'juicyads';

UPDATE ad_zones
SET zone_id = '1118510', width = 300, height = 250, updated_at = now()
WHERE provider_id = 'juicyads' AND placement = 'sidebar';

INSERT INTO ad_zones (provider_id, placement, zone_id, width, height, is_active, config)
VALUES
  ('juicyads', 'video_sidebar', '1118510', 300, 250, true, '{"size":"300x250"}'::jsonb),
  ('juicyads', 'creator_sidebar', '1118510', 300, 250, true, '{"size":"300x250"}'::jsonb),
  ('juicyads', 'live_sidebar', '1118510', 300, 250, true, '{"size":"300x250"}'::jsonb),
  ('juicyads', 'feed_sidebar', '1118510', 300, 250, true, '{"size":"300x250"}'::jsonb),
  ('juicyads', 'recommended_sidebar', '1118510', 300, 250, true, '{"size":"300x250"}'::jsonb)
ON CONFLICT (provider_id, placement, zone_id) DO UPDATE SET
  width = EXCLUDED.width,
  height = EXCLUDED.height,
  is_active = EXCLUDED.is_active,
  updated_at = now();

CREATE TABLE IF NOT EXISTS ad_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_key text NOT NULL UNIQUE,
  name text NOT NULL,
  page text NOT NULL,
  location text NOT NULL DEFAULT 'sidebar',
  width int NOT NULL DEFAULT 300,
  height int NOT NULL DEFAULT 250,
  size_label text NOT NULL DEFAULT '300x250',
  provider_type text NOT NULL DEFAULT 'mixed' CHECK (provider_type IN ('custom', 'third_party', 'mixed')),
  provider_id text REFERENCES ad_providers(id) ON DELETE SET NULL,
  zone_id text,
  embed_code text,
  custom_enabled boolean NOT NULL DEFAULT true,
  third_party_enabled boolean NOT NULL DEFAULT true,
  display_mode text NOT NULL DEFAULT 'custom_only' CHECK (display_mode IN ('custom_first', 'third_party_first', 'rotate', 'custom_only', 'third_party_only')),
  is_active boolean NOT NULL DEFAULT true,
  priority int NOT NULL DEFAULT 100,
  device_target text NOT NULL DEFAULT 'desktop' CHECK (device_target IN ('all', 'desktop', 'tablet', 'mobile')),
  frequency_cap int NOT NULL DEFAULT 0,
  schedule_start timestamptz,
  schedule_end timestamptz,
  impressions bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ad_slots_page ON ad_slots(page, is_active);
CREATE INDEX IF NOT EXISTS idx_ad_slots_priority ON ad_slots(priority);

INSERT INTO ad_slots (slot_key, name, page, location, width, height, provider_id, zone_id, device_target, priority)
VALUES
  ('home_sidebar', 'Home Sidebar MPU', 'home', 'sidebar', 300, 250, 'juicyads', '1118510', 'desktop', 10),
  ('video_sidebar', 'Video Page Sidebar', 'video', 'sidebar', 300, 250, 'juicyads', '1118510', 'desktop', 20),
  ('video_recommended', 'Video Recommended', 'video', 'recommended', 300, 250, 'juicyads', '1118510', 'desktop', 21),
  ('creator_sidebar', 'Creator Page Sidebar', 'creator', 'sidebar', 300, 250, 'juicyads', '1118510', 'desktop', 30),
  ('live_sidebar', 'Live Streams Sidebar', 'live', 'sidebar', 300, 250, 'juicyads', '1118510', 'desktop', 40),
  ('feed_sidebar', 'Feed Side Widget', 'feed', 'sidebar', 300, 250, 'juicyads', '1118510', 'tablet', 50),
  ('search_sidebar', 'Search Results Sidebar', 'search', 'sidebar', 300, 250, 'juicyads', '1118510', 'desktop', 60)
ON CONFLICT (slot_key) DO UPDATE SET
  zone_id = EXCLUDED.zone_id,
  provider_id = EXCLUDED.provider_id,
  updated_at = now();

INSERT INTO platform_settings (key, value, section, description, value_type)
VALUES
  ('sidebar_ads_enabled', 'true', 'Monetization', 'Enable sidebar 300x250 ad slots globally', 'toggle'),
  ('juicyads_sidebar_zone_id', '1118510', 'Monetization', 'JuicyAds zone ID for 300x250 sidebar units', 'text'),
  ('juicyads_script_url', 'https://poweredby.jads.co/js/jads.js', 'Monetization', 'JuicyAds v3 script URL', 'url'),
  ('sidebar_custom_ads_enabled', 'true', 'Monetization', 'Allow custom 300x250 sidebar ads', 'toggle'),
  ('sidebar_third_party_enabled', 'true', 'Monetization', 'Allow JuicyAds in sidebar slots', 'toggle')
ON CONFLICT (key) DO NOTHING;
