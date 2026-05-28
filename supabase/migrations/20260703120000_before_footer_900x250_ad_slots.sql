-- Adds page-specific 900x250 iframe banner slots that render immediately before the public footer.

with pages(page_key, page_label, sort_order) as (
  values
    ('home', 'Home', 0),
    ('video', 'Video watch', 1),
    ('leaderboard', 'Leaderboard', 2),
    ('channels', 'Channels', 3),
    ('stars', 'Stars', 4),
    ('creator', 'Creator profile', 5),
    ('creator_apply', 'Creator application', 6),
    ('creator_status', 'Creator status', 7),
    ('forum', 'Forum', 8),
    ('webmasters', 'Webmasters', 9),
    ('live_streams', 'Live streams', 10),
    ('live', 'Live cams/watch', 11),
    ('messages', 'Messages', 12),
    ('premium', 'Premium', 13),
    ('legal', 'Legal info', 14),
    ('auth', 'Auth pages', 15),
    ('wallet', 'Wallet', 16),
    ('purchases', 'Purchases', 17),
    ('application_update', 'Application update', 18),
    ('content_removal', 'Content removal', 19),
    ('tiktok', 'TikTok feed/watch', 20),
    ('terms', 'Terms', 21),
    ('privacy_policy', 'Privacy policy', 22),
    ('privacy_notice', 'Privacy notice', 23),
    ('cookies', 'Cookie preferences', 24)
)
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
select
  page_key || '_before_footer_900x250',
  page_label || ' Before Footer Banner 900x250',
  page_key,
  'before_footer',
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
  200 + sort_order,
  '{}'::jsonb
from pages
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
  device_target = 'all',
  priority = excluded.priority,
  updated_at = now();

update public.platform_settings
set value = replace(value, '"search_sidebar"', '"search_sidebar","before_footer"'),
    updated_at = now()
where key = 'ad_allowed_placements'
  and position('"before_footer"' in value) = 0;
