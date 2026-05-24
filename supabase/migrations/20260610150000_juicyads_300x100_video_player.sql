-- JuicyAds 300x100 companion unit (zone 1118515) — below video player / creator header

INSERT INTO ad_zones (provider_id, placement, zone_id, width, height, is_active, config)
VALUES
  ('juicyads', 'video_player', '1118515', 300, 100, true, '{"size":"300x100","label":"Below player"}'::jsonb),
  ('juicyads', 'creator_profile', '1118515', 300, 100, true, '{"size":"300x100","label":"Creator strip"}'::jsonb)
ON CONFLICT (provider_id, placement, zone_id) DO UPDATE SET
  width = EXCLUDED.width,
  height = EXCLUDED.height,
  is_active = EXCLUDED.is_active,
  config = EXCLUDED.config,
  updated_at = now();
