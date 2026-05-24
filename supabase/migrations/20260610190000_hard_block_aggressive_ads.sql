-- Hard-block aggressive ad formats and keep only pre-roll, feed/native, sidebar, and safe banner placements.

INSERT INTO public.platform_settings (key, value, section, description, value_type)
VALUES
  ('ad_safe_mode_strict', 'true', 'Safe Ads', 'Strict safe mode is permanently enabled', 'toggle'),
  ('ad_allow_popups', 'false', 'Safe Ads', 'Popups are permanently blocked', 'toggle'),
  ('ad_allow_redirects', 'false', 'Safe Ads', 'Ad-driven redirects are permanently blocked', 'toggle'),
  ('ad_allow_floating', 'false', 'Safe Ads', 'Floating and overlay ads are permanently blocked', 'toggle'),
  ('ad_block_aggressive', 'true', 'Safe Ads', 'Block aggressive ad formats and embed patterns', 'toggle'),
  ('ad_block_interstitials', 'true', 'Safe Ads', 'Block modal/fullscreen/interstitial ad takeovers', 'toggle'),
  ('ad_block_click_hijacking', 'true', 'Safe Ads', 'Block click hijacking outside approved ad slots', 'toggle'),
  ('ad_dom_guard_enabled', 'true', 'Safe Ads', 'Enable frontend DOM guard against overlay injection', 'toggle'),
  ('ad_click_isolation', 'true', 'Safe Ads', 'Isolate ad clicks inside approved containers only', 'toggle'),
  ('ad_safe_formats_only', 'true', 'Safe Ads', 'Only allow banner, display, native, vast, video formats', 'toggle'),
  ('ad_preroll_enabled', 'true', 'Safe Ads', 'Enable safe VAST pre-roll ads', 'toggle'),
  ('ad_feed_ads_enabled', 'true', 'Safe Ads', 'Enable native feed ads', 'toggle'),
  ('ad_banner_ads_enabled', 'true', 'Safe Ads', 'Enable safe in-layout banner ads', 'toggle'),
  ('ad_allowed_formats', '["banner","display","native","vast","video"]', 'Safe Ads', 'JSON array of allowed ad format keys', 'json'),
  ('ad_allowed_placements', '["video_preroll","feed","native_card","between_content","sidebar","home_sidebar","video_sidebar","video_recommended","creator_sidebar","live_sidebar","feed_sidebar","search_sidebar","homepage_banner","leaderboard","banner"]', 'Safe Ads', 'JSON array of approved placement keys', 'json'),
  ('ad_allowed_domains', '["juicyads.com","www.juicyads.com","js.juicyads.com","poweredby.jads.co","jads.co","exoclick.com","magsrv.com","s.magsrv.com","googleads.g.doubleclick.net","securepubads.g.doubleclick.net","googlesyndication.com"]', 'Safe Ads', 'JSON whitelist of safe ad script/tag domains', 'json'),
  ('ad_provider_priority_order', '["exoclick","juicyads","google_ad_manager"]', 'Monetization', 'Ordered list of safe ad provider slugs for fallback', 'json'),
  ('monetag_enabled', 'false', 'Monetization', 'Monetag is hard-blocked by the safe ads policy', 'toggle'),
  ('juicyads_script_url', 'https://poweredby.jads.co/js/jads.js', 'Monetization', 'Safe JuicyAds in-slot script URL', 'url')
ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value,
  section = EXCLUDED.section,
  description = EXCLUDED.description,
  value_type = EXCLUDED.value_type,
  updated_at = now();

UPDATE public.ad_providers
SET
  script_url = 'https://poweredby.jads.co/js/jads.js',
  config = COALESCE(config, '{}'::jsonb) || '{"scriptUrl":"https://poweredby.jads.co/js/jads.js","queueKey":"adsbyjuicy","safeFormats":["banner","native","display"]}'::jsonb,
  updated_at = now()
WHERE id = 'juicyads';

UPDATE public.ad_providers
SET is_enabled = false, is_maintenance = true, updated_at = now()
WHERE id = 'monetag' OR slug = 'monetag';

UPDATE public.ad_zones
SET is_active = false, updated_at = now()
WHERE provider_id = 'monetag'
   OR placement IN ('video_player', 'creator_profile')
   OR placement ILIKE '%popup%'
   OR placement ILIKE '%popunder%'
   OR placement ILIKE '%clickunder%'
   OR placement ILIKE '%interstitial%'
   OR placement ILIKE '%overlay%'
   OR placement ILIKE '%floating%';

UPDATE public.ad_campaigns
SET placement = 'homepage_banner', updated_at = now()
WHERE placement IN ('video_player', 'creator_profile')
   OR placement ILIKE '%popup%'
   OR placement ILIKE '%popunder%'
   OR placement ILIKE '%clickunder%'
   OR placement ILIKE '%interstitial%'
   OR placement ILIKE '%overlay%'
   OR placement ILIKE '%floating%';

ALTER TABLE IF EXISTS public.ad_campaigns
  DROP CONSTRAINT IF EXISTS ad_campaigns_placement_check;

ALTER TABLE IF EXISTS public.ad_campaigns
  ADD CONSTRAINT ad_campaigns_placement_check
  CHECK (placement IN ('homepage_banner', 'sidebar', 'feed'));
