-- Adds the homepage 160x600 softcore banner slot that can render an admin-pasted iframe embed.

insert into public.ad_slots (
  slot_key,
  name,
  page,
  location,
  width,
  height,
  size_label,
  provider_type,
  provider_id,
  zone_id,
  embed_code,
  custom_enabled,
  third_party_enabled,
  display_mode,
  is_active,
  device_target,
  priority,
  config
)
values (
  'home_softcore_160x600',
  'Home Softcore Banner 160x600',
  'home',
  'sidebar',
  160,
  600,
  '160x600',
  'custom',
  'juicyads',
  null,
  null,
  true,
  false,
  'custom_only',
  true,
  'desktop',
  12,
  '{}'::jsonb
)
on conflict (slot_key) do update set
  name = excluded.name,
  page = excluded.page,
  location = excluded.location,
  width = excluded.width,
  height = excluded.height,
  size_label = excluded.size_label,
  provider_type = excluded.provider_type,
  provider_id = excluded.provider_id,
  custom_enabled = true,
  third_party_enabled = false,
  display_mode = 'custom_only',
  is_active = true,
  device_target = 'desktop',
  priority = excluded.priority,
  updated_at = now();

update public.platform_settings
set value = replace(value, '"home_sidebar"', '"home_sidebar","home_softcore_160x600"'),
    updated_at = now()
where key = 'ad_allowed_placements'
  and position('"home_softcore_160x600"' in value) = 0;

update public.platform_settings
set value = replace(value, '"googlesyndication.com"', '"googlesyndication.com","adtng.com","a.adtng.com"'),
    updated_at = now()
where key = 'ad_allowed_domains'
  and position('"adtng.com"' in value) = 0;
