-- Production ExoClick VAST pre-roll configuration for zone 5963164.
-- This migration overrides earlier VAST defaults while preserving historical rows
-- as inactive records for auditability.

insert into public.platform_settings (key, value, section, description, value_type, updated_at)
values
  ('vast_enabled', 'true', 'Video Ad Settings', 'Enable VAST pre-roll ads', 'toggle', now()),
  ('vast_provider', 'monetag', 'Video Ad Settings', 'Active VAST provider', 'select', now()),
  ('exoclick_vast_tag_url', 'https://s.magsrv.com/v1/vast.php?idz=5963164', 'Monetization', 'ExoClick VAST pre-roll tag URL', 'url', now()),
  ('vast_ad_timeout_sec', '5', 'Monetization', 'VAST pre-roll timeout in seconds', 'number', now())
on conflict (key) do update set
  value = excluded.value,
  section = coalesce(excluded.section, public.platform_settings.section),
  description = coalesce(excluded.description, public.platform_settings.description),
  value_type = coalesce(excluded.value_type, public.platform_settings.value_type),
  updated_at = now();

insert into public.ad_providers (
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
  skip_after_seconds,
  skippable,
  ad_frequency,
  retry_limit,
  timeout_ms
)
values (
  'exoclick',
  'ExoClick',
  'exoclick',
  'vast',
  true,
  false,
  10,
  null,
  '{"displayScriptUrl":"https://a.magsrv.com/ad-provider.js","displayZoneId":"5933054","vastZoneId":"5963164","vastTagUrl":"https://s.magsrv.com/v1/vast.php?idz=5963164","insClass":"eas6a97888e6","keywords":"keywords","sub":"123450000","blockAdTypes":"0","exAv":"name"}'::jsonb,
  2.0000,
  5,
  true,
  3,
  2,
  5000
)
on conflict (id) do update set
  name = excluded.name,
  slug = excluded.slug,
  provider_type = excluded.provider_type,
  is_enabled = true,
  is_maintenance = false,
  priority = excluded.priority,
  script_url = excluded.script_url,
  config = coalesce(public.ad_providers.config, '{}'::jsonb) || excluded.config,
  estimated_cpm_usd = excluded.estimated_cpm_usd,
  skip_after_seconds = excluded.skip_after_seconds,
  skippable = excluded.skippable,
  ad_frequency = excluded.ad_frequency,
  retry_limit = excluded.retry_limit,
  timeout_ms = excluded.timeout_ms,
  updated_at = now();

insert into public.ad_zones (provider_id, placement, zone_id, tag_url, width, height, is_active, config, updated_at)
values (
  'exoclick',
  'video_preroll',
  '5963164',
  'https://s.magsrv.com/v1/vast.php?idz=5963164',
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

update public.ad_zones
set is_active = false,
    updated_at = now()
where provider_id = 'exoclick'
  and placement = 'video_preroll'
  and zone_id <> '5963164';
