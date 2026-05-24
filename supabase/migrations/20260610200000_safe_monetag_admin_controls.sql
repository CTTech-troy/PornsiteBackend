-- Re-enable Monetag only through the safe ad system.
-- Popups, redirects, clickunders, interstitials, and overlays remain blocked by policy.

INSERT INTO public.platform_settings (key, value, section, description, value_type)
VALUES
  ('monetag_enabled', 'false', 'Monetization', 'Enable Monetag safe mode globally', 'toggle'),
  ('monetag_native_enabled', 'false', 'Monetization', 'Enable Monetag native/feed slots only', 'toggle'),
  ('monetag_sidebar_enabled', 'false', 'Monetization', 'Enable Monetag sidebar/banner slots only', 'toggle'),
  ('monetag_banner_enabled', 'false', 'Monetization', 'Enable Monetag in-layout banner slots only', 'toggle'),
  ('monetag_script_url', '', 'Monetization', 'Safe Monetag script URL for sandboxed slots', 'url'),
  ('monetag_native_zone_id', '', 'Monetization', 'Monetag native/feed zone ID', 'text'),
  ('monetag_sidebar_zone_id', '', 'Monetization', 'Monetag sidebar zone ID', 'text'),
  ('monetag_banner_zone_id', '', 'Monetization', 'Monetag banner zone ID', 'text'),
  ('monetag_allowed_pages', '["home","video","creator","feed","search","live"]', 'Monetization', 'Pages where Monetag safe slots may render', 'json'),
  ('monetag_allowed_slots', '["feed_native","home_sidebar","video_sidebar","video_recommended","creator_sidebar","live_sidebar","feed_sidebar","search_sidebar","homepage_banner","leaderboard","banner"]', 'Monetization', 'Slot keys where Monetag safe slots may render', 'json'),
  ('monetag_allowed_domains', '["monetag.com","www.monetag.com","highperformanceformat.com","profitablecpmrate.com","profitablecpmgate.com","alwingulla.com"]', 'Monetization', 'Exact Monetag domains allowed in sandboxed slots', 'json'),
  ('ad_allowed_domains', '["juicyads.com","www.juicyads.com","js.juicyads.com","poweredby.jads.co","jads.co","exoclick.com","magsrv.com","s.magsrv.com","googleads.g.doubleclick.net","securepubads.g.doubleclick.net","googlesyndication.com","monetag.com","www.monetag.com","highperformanceformat.com","profitablecpmrate.com","profitablecpmgate.com","alwingulla.com"]', 'Safe Ads', 'JSON whitelist of safe ad script/tag domains', 'json'),
  ('ad_provider_priority_order', '["exoclick","juicyads","monetag","google_ad_manager"]', 'Monetization', 'Ordered list of safe ad provider slugs for fallback', 'json')
ON CONFLICT (key) DO UPDATE SET
  section = EXCLUDED.section,
  description = EXCLUDED.description,
  value_type = EXCLUDED.value_type,
  updated_at = now();

INSERT INTO public.ad_providers (id, name, slug, provider_type, is_enabled, is_maintenance, priority, script_url, config, estimated_cpm_usd, skip_after_seconds)
VALUES
  ('monetag', 'Monetag', 'monetag', 'display', false, false, 30, NULL, '{"safeMode":true,"sandboxed":true,"allowedFormats":["native","banner","display"]}'::jsonb, 1.2000, 5)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  slug = EXCLUDED.slug,
  provider_type = EXCLUDED.provider_type,
  is_maintenance = false,
  priority = EXCLUDED.priority,
  config = COALESCE(public.ad_providers.config, '{}'::jsonb) || EXCLUDED.config,
  updated_at = now();

UPDATE public.ad_zones
SET is_active = false, updated_at = now()
WHERE provider_id = 'monetag'
  AND (
    placement = 'video_preroll'
    OR placement ILIKE '%popup%'
    OR placement ILIKE '%popunder%'
    OR placement ILIKE '%clickunder%'
    OR placement ILIKE '%interstitial%'
    OR placement ILIKE '%overlay%'
    OR placement ILIKE '%floating%'
    OR placement ILIKE '%redirect%'
  );

