-- Production-safe Monetag rendering defaults.
-- Allows only the approved sandboxed display/native/sidebar tag and keeps
-- popup, redirect, clickunder, interstitial, and overlay formats blocked.

insert into platform_settings (key, value, section, description, type)
values
  ('monetag_enabled', 'true', 'Monetization', 'Enable Monetag safe mode globally', 'toggle'),
  ('monetag_native_enabled', 'true', 'Monetization', 'Enable Monetag native/feed slots only', 'toggle'),
  ('monetag_sidebar_enabled', 'true', 'Monetization', 'Enable Monetag sidebar/banner slots only', 'toggle'),
  ('monetag_banner_enabled', 'true', 'Monetization', 'Enable Monetag in-layout banner slots only', 'toggle'),
  ('monetag_script_url', 'https://quge5.com/88/tag.min.js', 'Monetization', 'Approved sandboxed Monetag script URL', 'url'),
  ('monetag_native_zone_id', '242279', 'Monetization', 'Approved Monetag native/feed zone ID', 'text'),
  ('monetag_sidebar_zone_id', '242279', 'Monetization', 'Approved Monetag sidebar zone ID', 'text'),
  ('monetag_banner_zone_id', '242279', 'Monetization', 'Approved Monetag banner zone ID', 'text'),
  ('monetag_allowed_domains', '["quge5.com","monetag.com","www.monetag.com","highperformanceformat.com","profitablecpmrate.com","profitablecpmgate.com","alwingulla.com"]', 'Monetization', 'Exact Monetag domains allowed in sandboxed slots', 'json'),
  ('ad_allowed_domains', '["juicyads.com","www.juicyads.com","js.juicyads.com","poweredby.jads.co","jads.co","exoclick.com","magsrv.com","s.magsrv.com","googleads.g.doubleclick.net","securepubads.g.doubleclick.net","googlesyndication.com","quge5.com","monetag.com","www.monetag.com","highperformanceformat.com","profitablecpmrate.com","profitablecpmgate.com","alwingulla.com"]', 'Safe Ads', 'JSON whitelist of safe ad script/tag domains', 'json'),
  ('ad_provider_priority_order', '["monetag","juicyads","exoclick","google_ad_manager"]', 'Monetization', 'Safe display provider fallback order', 'json')
on conflict (key) do update
set value = excluded.value,
    section = excluded.section,
    description = excluded.description,
    type = excluded.type,
    updated_at = now();

insert into ad_providers (
  id,
  name,
  slug,
  provider_type,
  is_enabled,
  is_maintenance,
  priority,
  script_url,
  config,
  estimated_cpm_usd,
  skip_after_seconds
)
values (
  'monetag',
  'Monetag',
  'monetag',
  'display',
  true,
  false,
  30,
  'https://quge5.com/88/tag.min.js',
  '{"safeMode":true,"sandboxed":true,"allowedFormats":["native","banner","display"],"blockedFormats":["popup","popunder","clickunder","interstitial","overlay"]}'::jsonb,
  1.2000,
  5
)
on conflict (id) do update
set is_enabled = true,
    is_maintenance = false,
    priority = 30,
    script_url = 'https://quge5.com/88/tag.min.js',
    config = excluded.config,
    updated_at = now();

insert into ad_zones (provider_id, placement, zone_id, tag_url, width, height, is_active, config)
values
  ('monetag', 'feed', '242279', null, 640, 360, true, '{"safeSlot":true}'::jsonb),
  ('monetag', 'sidebar', '242279', null, 300, 250, true, '{"safeSlot":true}'::jsonb),
  ('monetag', 'leaderboard', '242279', null, 728, 90, true, '{"safeSlot":true}'::jsonb)
on conflict (provider_id, placement, zone_id) do update
set width = excluded.width,
    height = excluded.height,
    is_active = true,
    config = excluded.config,
    updated_at = now();

update ad_slots
set provider_id = 'monetag',
    zone_id = coalesce(nullif(zone_id, ''), '242279'),
    third_party_enabled = true,
    display_mode = case
      when display_mode = 'custom_only' then 'third_party_first'
      else coalesce(display_mode, 'third_party_first')
    end,
    device_target = case
      when device_target = 'desktop' then 'all'
      else coalesce(device_target, 'all')
    end,
    updated_at = now()
where slot_key in (
  'home_sidebar',
  'video_sidebar',
  'video_recommended',
  'creator_sidebar',
  'live_sidebar',
  'feed_sidebar',
  'search_sidebar'
);
