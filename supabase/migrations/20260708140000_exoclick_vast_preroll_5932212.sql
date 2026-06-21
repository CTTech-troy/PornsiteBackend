-- Production ExoClick VAST pre-roll configuration.
-- Keeps the runtime VAST tag, provider zone, and timeout aligned with the
-- frontend Video.js VAST/VPAID pre-roll implementation.

insert into public.platform_settings (key, value, section, description, value_type, updated_at)
values
  ('exoclick_vast_tag_url', 'https://s.magsrv.com/v1/vast.php?idz=5932212', 'Monetization', 'ExoClick VAST pre-roll tag URL', 'url', now()),
  ('vast_ad_timeout_sec', '5', 'Monetization', 'VAST pre-roll timeout in seconds', 'number', now())
on conflict (key) do update set
  value = excluded.value,
  section = coalesce(excluded.section, public.platform_settings.section),
  description = coalesce(excluded.description, public.platform_settings.description),
  value_type = coalesce(excluded.value_type, public.platform_settings.value_type),
  updated_at = now();

update public.ad_providers
set
  provider_type = 'vast',
  is_enabled = true,
  timeout_ms = 5000,
  config = coalesce(config, '{}'::jsonb)
    || '{"vastZoneId":"5932212","vastTagUrl":"https://s.magsrv.com/v1/vast.php?idz=5932212"}'::jsonb,
  updated_at = now()
where id = 'exoclick';

insert into public.ad_zones (provider_id, placement, zone_id, tag_url, width, height, is_active, config, updated_at)
values (
  'exoclick',
  'video_preroll',
  '5932212',
  'https://s.magsrv.com/v1/vast.php?idz=5932212',
  null,
  null,
  true,
  '{}'::jsonb,
  now()
)
on conflict (provider_id, placement, zone_id) do update set
  tag_url = excluded.tag_url,
  is_active = true,
  updated_at = now();

delete from public.ad_zones
where provider_id = 'exoclick'
  and placement = 'video_preroll'
  and zone_id <> '5932212';
