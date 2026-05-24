-- Safe ad placement & non-intrusive ads policy settings

INSERT INTO public.platform_settings (key, value, section, description, value_type)
VALUES
  ('ad_safe_mode_strict', 'true', 'Safe Ads', 'Strict safe mode: block popups, redirects, floating ads', 'toggle'),
  ('ad_allow_popups', 'false', 'Safe Ads', 'Allow ad popups (disabled when strict mode is on)', 'toggle'),
  ('ad_allow_redirects', 'false', 'Safe Ads', 'Allow ad-driven top-level redirects', 'toggle'),
  ('ad_allow_floating', 'false', 'Safe Ads', 'Allow floating ads outside approved slots', 'toggle'),
  ('ad_block_aggressive', 'true', 'Safe Ads', 'Block aggressive ad formats and embed patterns', 'toggle'),
  ('ad_max_width_px', '970', 'Safe Ads', 'Global maximum ad width in pixels', 'number'),
  ('ad_max_height_px', '600', 'Safe Ads', 'Global maximum ad height in pixels', 'number'),
  ('ad_dom_guard_enabled', 'true', 'Safe Ads', 'Enable frontend DOM guard against overlay injection', 'toggle'),
  ('ad_click_isolation', 'true', 'Safe Ads', 'Isolate ad clicks inside approved containers only', 'toggle'),
  ('ad_allowed_placements', '["sidebar","feed","homepage_banner","leaderboard","banner","header_banner","footer","between_content","native_card","video_preroll","video_player","creator_profile","home_sidebar","video_sidebar","creator_sidebar","live_sidebar","feed_sidebar"]', 'Safe Ads', 'JSON array of allowed placement keys', 'json'),
  ('ad_allowed_domains', '["juicyads.com","jads.co","poweredby.jads.co","adserver.juicyads.com","exoclick.com","magsrv.com","s.magsrv.com"]', 'Safe Ads', 'JSON whitelist of ad script/tag domains', 'json')
ON CONFLICT (key) DO NOTHING;
