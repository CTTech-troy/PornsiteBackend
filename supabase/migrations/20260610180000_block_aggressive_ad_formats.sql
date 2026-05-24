-- Block aggressive popup/interstitial ad formats platform-wide

INSERT INTO public.platform_settings (key, value, section, description, value_type)
VALUES
  ('ad_safe_mode_strict', 'true', 'Safe Ads', 'Strict safe mode: block popups, redirects, floating ads', 'toggle'),
  ('ad_allow_popups', 'false', 'Safe Ads', 'Allow ad popups (disabled when strict mode is on)', 'toggle'),
  ('ad_allow_redirects', 'false', 'Safe Ads', 'Allow ad-driven top-level redirects', 'toggle'),
  ('ad_allow_floating', 'false', 'Safe Ads', 'Allow floating ads outside approved slots', 'toggle'),
  ('ad_block_interstitials', 'true', 'Safe Ads', 'Block interstitial and modal ad takeovers', 'toggle'),
  ('ad_block_click_hijacking', 'true', 'Safe Ads', 'Block click hijacking outside ad slots', 'toggle'),
  ('ad_safe_formats_only', 'true', 'Safe Ads', 'Only allow banner, display, native, vast, video formats', 'toggle'),
  ('ad_allowed_formats', '["banner","display","native","vast","video"]', 'Safe Ads', 'JSON array of allowed ad format keys', 'json')
ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value,
  section = EXCLUDED.section,
  description = EXCLUDED.description,
  value_type = EXCLUDED.value_type,
  updated_at = now();

UPDATE ad_providers
SET
  script_url = 'https://poweredby.jads.co/js/jads.js',
  config = COALESCE(config, '{}'::jsonb) || '{"scriptUrl":"https://poweredby.jads.co/js/jads.js","queueKey":"adsbyjuicy"}'::jsonb,
  updated_at = now()
WHERE id = 'juicyads';

UPDATE ad_providers
SET is_enabled = false, updated_at = now()
WHERE id = 'monetag';

UPDATE platform_settings
SET value = 'https://poweredby.jads.co/js/jads.js', updated_at = now()
WHERE key = 'juicyads_script_url' AND value LIKE '%adserver.juicyads.com%';
