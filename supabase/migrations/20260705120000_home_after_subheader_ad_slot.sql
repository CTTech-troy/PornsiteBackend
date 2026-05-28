-- Adds the home-page 900x250 iframe banner rendered immediately after the public subheader.

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
  'home_after_subheader_900x250',
  'Home After Subheader Banner 900x250',
  'home',
  'after_subheader',
  900,
  250,
  '900x250',
  'custom',
  'juicyads',
  null,
  null,
  true,
  false,
  'custom_only',
  true,
  'all',
  8,
  '{}'::jsonb
)
on conflict (slot_key) do update set
  name = excluded.name,
  page = 'home',
  location = 'after_subheader',
  width = 900,
  height = 250,
  size_label = '900x250',
  provider_type = coalesce(ad_slots.provider_type, excluded.provider_type),
  provider_id = coalesce(ad_slots.provider_id, excluded.provider_id),
  custom_enabled = true,
  display_mode = coalesce(ad_slots.display_mode, 'custom_only'),
  is_active = true,
  device_target = 'all',
  priority = excluded.priority,
  updated_at = now();

update public.platform_settings
set value = replace(value, '"home_sidebar"', '"home_after_subheader_900x250","home_sidebar"'),
    updated_at = now()
where key = 'ad_allowed_placements'
  and position('"home_after_subheader_900x250"' in value) = 0
  and position('"home_sidebar"' in value) > 0;

update public.platform_settings
set value = replace(value, '"home_sidebar"', '"home_after_subheader_900x250","home_sidebar"'),
    updated_at = now()
where key = 'monetag_allowed_slots'
  and position('"home_after_subheader_900x250"' in value) = 0
  and position('"home_sidebar"' in value) > 0;
