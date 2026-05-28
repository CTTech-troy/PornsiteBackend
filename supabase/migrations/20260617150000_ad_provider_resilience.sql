-- Public ad provider API resilience.
-- Keeps sidebar/feed/mobile ad endpoints stable when deployments are missing
-- optional ad tables, settings, or default slot rows.

create extension if not exists pgcrypto;

create table if not exists public.ad_providers (
  id text primary key,
  name text not null,
  slug text not null unique,
  provider_type text not null default 'display',
  is_enabled boolean not null default true,
  is_maintenance boolean not null default false,
  priority integer not null default 100,
  script_url text,
  config jsonb not null default '{}'::jsonb,
  estimated_cpm_usd numeric(10,4) not null default 0,
  skip_after_seconds integer not null default 5,
  skippable boolean not null default true,
  ad_frequency integer not null default 3,
  retry_limit integer not null default 2,
  timeout_ms integer not null default 8000,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_health_status text not null default 'unknown',
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  failed_requests bigint not null default 0,
  revenue_usd numeric(14,4) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ad_zones (
  id uuid primary key default gen_random_uuid(),
  provider_id text references public.ad_providers(id) on delete cascade,
  placement text not null,
  zone_id text not null,
  tag_url text,
  width integer,
  height integer,
  is_active boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  impressions bigint not null default 0,
  failed_loads bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_id, placement, zone_id)
);

create table if not exists public.ad_slots (
  id uuid primary key default gen_random_uuid(),
  slot_key text not null unique,
  name text not null,
  page text not null,
  location text not null default 'sidebar',
  width integer not null default 300,
  height integer not null default 250,
  size_label text not null default '300x250',
  provider_type text not null default 'mixed',
  provider_id text references public.ad_providers(id) on delete set null,
  zone_id text,
  embed_code text,
  custom_enabled boolean not null default true,
  third_party_enabled boolean not null default true,
  display_mode text not null default 'third_party_first',
  is_active boolean not null default true,
  priority integer not null default 100,
  device_target text not null default 'all',
  frequency_cap integer not null default 0,
  schedule_start timestamptz,
  schedule_end timestamptz,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ad_monitoring_events (
  id uuid primary key default gen_random_uuid(),
  provider_id text references public.ad_providers(id) on delete set null,
  zone_id uuid references public.ad_zones(id) on delete set null,
  session_id text,
  video_id text,
  user_id text,
  fingerprint text,
  event_type text not null default 'diagnostic',
  placement text,
  device_type text,
  browser text,
  country text,
  revenue_usd numeric(12,6) not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.ad_safe_policy (
  id text primary key default 'default',
  allow_preroll boolean not null default true,
  allow_sidebar_ads boolean not null default true,
  allow_feed_ads boolean not null default true,
  block_popups boolean not null default true,
  block_redirects boolean not null default true,
  block_interstitials boolean not null default true,
  allowed_placements text[] not null default array[
    'video_preroll','feed','native_card','between_content','sidebar','home_sidebar',
    'video_sidebar','video_recommended','creator_sidebar','live_sidebar','feed_sidebar',
    'search_sidebar','homepage_banner','leaderboard','banner'
  ],
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.ad_campaigns (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  name text not null default '',
  title text not null default '',
  description text,
  image_url text,
  redirect_url text not null default '',
  click_url text,
  cta_text text not null default 'Learn More',
  placement text not null default 'sidebar',
  type text not null default 'image',
  creative_type text not null default 'image',
  status text not null default 'pending',
  is_active boolean not null default false,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  budget numeric(14,4) not null default 0,
  budget_usd numeric(14,4),
  cpc numeric(14,4) not null default 0,
  revenue_usd numeric(14,4) not null default 0,
  embed_html text,
  embed_sanitized_html text,
  network_visible boolean not null default false,
  payment_status text not null default 'waived',
  source_type text not null default 'image',
  ownership text not null default 'platform',
  priority integer not null default 1,
  start_date timestamptz,
  expiry_date timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists public.ad_campaigns
  add column if not exists user_id text,
  add column if not exists name text not null default '',
  add column if not exists title text not null default '',
  add column if not exists description text,
  add column if not exists image_url text,
  add column if not exists redirect_url text not null default '',
  add column if not exists click_url text,
  add column if not exists cta_text text not null default 'Learn More',
  add column if not exists placement text not null default 'sidebar',
  add column if not exists type text not null default 'image',
  add column if not exists creative_type text not null default 'image',
  add column if not exists status text not null default 'pending',
  add column if not exists priority integer not null default 1,
  add column if not exists network_visible boolean not null default false,
  add column if not exists payment_status text not null default 'waived',
  add column if not exists source_type text not null default 'image',
  add column if not exists ownership text not null default 'platform',
  add column if not exists image_width integer,
  add column if not exists image_height integer,
  add column if not exists embed_sanitized_html text,
  add column if not exists is_active boolean not null default false,
  add column if not exists revenue_usd numeric(14,4) not null default 0;

create table if not exists public.ad_impressions (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid,
  user_id text,
  session_id text,
  placement text,
  slot_key text,
  fingerprint text,
  ip_hash text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table if exists public.ad_impressions
  add column if not exists campaign_id uuid,
  add column if not exists user_id text,
  add column if not exists session_id text,
  add column if not exists placement text,
  add column if not exists slot_key text,
  add column if not exists fingerprint text,
  add column if not exists ip_hash text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

do $$
begin
  if to_regclass('public.ad_impressions') is not null then
    begin
      alter table public.ad_impressions alter column campaign_id drop not null;
    exception when others then
      null;
    end;
  end if;
end $$;

create table if not exists public.platform_settings (
  key text primary key,
  value text not null default '',
  updated_at timestamptz not null default now()
);

alter table if exists public.platform_settings
  add column if not exists section text,
  add column if not exists description text,
  add column if not exists value_type text,
  add column if not exists type text,
  add column if not exists is_sensitive boolean not null default false,
  add column if not exists updated_by text;

insert into public.ad_providers (id, name, slug, provider_type, is_enabled, is_maintenance, priority, script_url, config, estimated_cpm_usd, skip_after_seconds)
values
  ('exoclick', 'ExoClick', 'exoclick', 'display', true, false, 10, 'https://a.magsrv.com/ad-provider.js', '{"displayZoneId":"5933054","vastZoneId":"5933056","insClass":"eas6a97888e6","keywords":"keywords","sub":"123450000","blockAdTypes":"0","exAv":"name"}'::jsonb, 2.0000, 5),
  ('juicyads', 'JuicyAds', 'juicyads', 'display', true, false, 20, 'https://poweredby.jads.co/js/jads.js', '{"queueKey":"adsbyjuicy","defaultZoneId":"1118510","defaultWidth":300,"defaultHeight":250}'::jsonb, 1.5000, 5),
  ('monetag', 'Monetag', 'monetag', 'display', true, false, 30, 'https://quge5.com/88/tag.min.js', '{"safeMode":true,"sandboxed":true}'::jsonb, 1.2000, 5),
  ('google_ad_manager', 'Google Ad Manager', 'google_ad_manager', 'gam', false, false, 40, 'https://securepubads.g.doubleclick.net/tag/js/gpt.js', '{}'::jsonb, 3.0000, 5)
on conflict (id) do update set
  name = excluded.name,
  slug = excluded.slug,
  provider_type = excluded.provider_type,
  is_enabled = case when public.ad_providers.id in ('exoclick','juicyads','monetag') then true else public.ad_providers.is_enabled end,
  is_maintenance = false,
  script_url = excluded.script_url,
  config = coalesce(public.ad_providers.config, '{}'::jsonb) || excluded.config,
  updated_at = now();

insert into public.ad_zones (provider_id, placement, zone_id, tag_url, width, height, is_active, config)
values
  ('exoclick', 'video_preroll', '5933056', 'https://s.magsrv.com/v1/vast.php?idzone=5933056', null, null, true, '{}'::jsonb),
  ('exoclick', 'sidebar', '5933054', 'https://a.magsrv.com/ad-provider.js', 300, 250, true, '{"insClass":"eas6a97888e6"}'::jsonb),
  ('exoclick', 'feed', '5933054', 'https://a.magsrv.com/ad-provider.js', 640, 360, true, '{"insClass":"eas6a97888e6"}'::jsonb),
  ('juicyads', 'sidebar', '1118510', null, 300, 250, true, '{"size":"300x250"}'::jsonb),
  ('monetag', 'sidebar', '242279', null, 300, 250, true, '{"safeSlot":true}'::jsonb),
  ('monetag', 'feed', '242279', null, 640, 360, true, '{"safeSlot":true}'::jsonb),
  ('monetag', 'leaderboard', '242279', null, 728, 90, true, '{"safeSlot":true}'::jsonb)
on conflict (provider_id, placement, zone_id) do update set
  tag_url = excluded.tag_url,
  width = excluded.width,
  height = excluded.height,
  is_active = true,
  config = coalesce(public.ad_zones.config, '{}'::jsonb) || excluded.config,
  updated_at = now();

insert into public.ad_slots (slot_key, name, page, location, width, height, size_label, provider_type, provider_id, zone_id, custom_enabled, third_party_enabled, display_mode, is_active, device_target, priority)
values
  ('home_sidebar', 'Home Sidebar MPU', 'home', 'sidebar', 300, 250, '300x250', 'mixed', 'monetag', '242279', true, true, 'third_party_first', true, 'all', 10),
  ('video_sidebar', 'Video Page Sidebar', 'video', 'sidebar', 300, 250, '300x250', 'mixed', 'monetag', '242279', true, true, 'third_party_first', true, 'all', 20),
  ('video_recommended', 'Video Recommended Sidebar', 'video', 'recommended', 300, 250, '300x250', 'mixed', 'monetag', '242279', true, true, 'third_party_first', true, 'all', 30),
  ('creator_sidebar', 'Creator Sidebar MPU', 'creator', 'sidebar', 300, 250, '300x250', 'mixed', 'monetag', '242279', true, true, 'third_party_first', true, 'all', 40),
  ('live_sidebar', 'Live Sidebar MPU', 'live', 'sidebar', 300, 250, '300x250', 'mixed', 'monetag', '242279', true, true, 'third_party_first', true, 'all', 50),
  ('feed_sidebar', 'Feed Sidebar MPU', 'feed', 'sidebar', 300, 250, '300x250', 'mixed', 'monetag', '242279', true, true, 'third_party_first', true, 'all', 60),
  ('search_sidebar', 'Search Sidebar MPU', 'search', 'sidebar', 300, 250, '300x250', 'mixed', 'monetag', '242279', true, true, 'third_party_first', true, 'all', 70)
on conflict (slot_key) do update set
  width = excluded.width,
  height = excluded.height,
  size_label = excluded.size_label,
  provider_type = excluded.provider_type,
  provider_id = excluded.provider_id,
  zone_id = excluded.zone_id,
  third_party_enabled = true,
  display_mode = excluded.display_mode,
  is_active = true,
  device_target = 'all',
  updated_at = now();

insert into public.ad_safe_policy (id)
values ('default')
on conflict (id) do update set
  allow_preroll = true,
  allow_sidebar_ads = true,
  allow_feed_ads = true,
  block_popups = true,
  block_redirects = true,
  block_interstitials = true,
  updated_at = now();

insert into public.platform_settings (key, value, section, description, value_type)
values
  ('ad_preroll_enabled', 'true', 'Safe Ads', 'Enable safe pre-roll ads', 'toggle'),
  ('ad_feed_ads_enabled', 'true', 'Safe Ads', 'Enable safe feed ads', 'toggle'),
  ('sidebar_ads_enabled', 'true', 'Monetization', 'Enable sidebar ad slots globally', 'toggle'),
  ('sidebar_custom_ads_enabled', 'true', 'Monetization', 'Allow admin custom sidebar ads', 'toggle'),
  ('sidebar_third_party_enabled', 'true', 'Monetization', 'Allow safe third-party sidebar ads', 'toggle'),
  ('juicyads_enabled', 'true', 'Monetization', 'Enable JuicyAds display network', 'toggle'),
  ('juicyads_script_url', 'https://poweredby.jads.co/js/jads.js', 'Monetization', 'JuicyAds safe script URL', 'url'),
  ('juicyads_sidebar_zone_id', '1118510', 'Monetization', 'JuicyAds sidebar zone', 'text'),
  ('monetag_enabled', 'true', 'Monetization', 'Enable Monetag safe slots', 'toggle'),
  ('monetag_native_enabled', 'true', 'Monetization', 'Enable Monetag native slots', 'toggle'),
  ('monetag_sidebar_enabled', 'true', 'Monetization', 'Enable Monetag sidebar slots', 'toggle'),
  ('monetag_banner_enabled', 'true', 'Monetization', 'Enable Monetag banner slots', 'toggle'),
  ('monetag_script_url', 'https://quge5.com/88/tag.min.js', 'Monetization', 'Approved Monetag safe script', 'url'),
  ('monetag_native_zone_id', '242279', 'Monetization', 'Approved Monetag native zone', 'text'),
  ('monetag_sidebar_zone_id', '242279', 'Monetization', 'Approved Monetag sidebar zone', 'text'),
  ('monetag_banner_zone_id', '242279', 'Monetization', 'Approved Monetag banner zone', 'text'),
  ('monetag_allowed_pages', '["home","video","creator","feed","search","live"]', 'Monetization', 'Pages where Monetag may render', 'json'),
  ('monetag_allowed_slots', '["feed_native","home_sidebar","video_sidebar","video_recommended","creator_sidebar","live_sidebar","feed_sidebar","search_sidebar","homepage_banner","leaderboard","banner"]', 'Monetization', 'Slots where Monetag may render', 'json'),
  ('ad_allowed_placements', '["video_preroll","feed","native_card","between_content","sidebar","home_sidebar","video_sidebar","video_recommended","creator_sidebar","live_sidebar","feed_sidebar","search_sidebar","homepage_banner","leaderboard","banner"]', 'Safe Ads', 'Approved public ad placements', 'json'),
  ('ad_provider_priority_order', '["exoclick","juicyads","monetag","google_ad_manager"]', 'Monetization', 'Safe provider fallback order', 'json')
on conflict (key) do update set
  value = excluded.value,
  section = excluded.section,
  description = excluded.description,
  value_type = excluded.value_type,
  updated_at = now()
where public.platform_settings.key in (
  'ad_preroll_enabled',
  'ad_feed_ads_enabled',
  'sidebar_ads_enabled',
  'sidebar_third_party_enabled',
  'juicyads_enabled',
  'monetag_enabled',
  'monetag_native_enabled',
  'monetag_sidebar_enabled',
  'monetag_banner_enabled',
  'monetag_script_url',
  'monetag_native_zone_id',
  'monetag_sidebar_zone_id',
  'monetag_banner_zone_id',
  'ad_allowed_placements',
  'ad_provider_priority_order'
);

create index if not exists idx_ad_slots_public_config
  on public.ad_slots(page, device_target, is_active, priority);

create index if not exists idx_ad_monitoring_events_public
  on public.ad_monitoring_events(provider_id, placement, event_type, created_at desc);

create index if not exists idx_ad_monitoring_events_session
  on public.ad_monitoring_events(session_id, created_at desc);

create index if not exists idx_ad_campaigns_public_serve
  on public.ad_campaigns(placement, status, is_active, priority desc, created_at desc);

create index if not exists idx_ad_impressions_slot_created
  on public.ad_impressions(slot_key, created_at desc)
  where slot_key is not null;
