-- Admin-controlled homepage/category feed ad placement architecture.

ALTER TABLE public.ad_campaigns
  DROP CONSTRAINT IF EXISTS ad_campaigns_placement_check;

ALTER TABLE public.ad_campaigns
  ADD CONSTRAINT ad_campaigns_placement_check
  CHECK (placement IN (
    'homepage_banner',
    'homepage_top',
    'homepage_bottom',
    'sidebar',
    'feed',
    'feed_native',
    'mobile_inline',
    'category_feed',
    'video_page',
    'sticky_banner',
    'native_card',
    'before_footer',
    'video_player',
    'creator_profile'
  ));

ALTER TABLE public.ad_campaigns
  ADD COLUMN IF NOT EXISTS slot_key text,
  ADD COLUMN IF NOT EXISTS placement_type text,
  ADD COLUMN IF NOT EXISTS ad_size text,
  ADD COLUMN IF NOT EXISTS device_target text NOT NULL DEFAULT 'all',
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS render_failures bigint NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_ad_campaigns_slot_key
  ON public.ad_campaigns (slot_key)
  WHERE slot_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ad_campaigns_device_target
  ON public.ad_campaigns (device_target, placement, status, is_active);

INSERT INTO public.ad_slots (
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
  priority,
  device_target,
  frequency_cap,
  config
)
VALUES
  (
    'home_feed_native',
    'Home Feed Native Card',
    'home',
    'feed_native',
    300,
    250,
    '300x250',
    'custom',
    'juicyads',
    NULL,
    NULL,
    true,
    false,
    'custom_first',
    true,
    9,
    'all',
    6,
    '{"placement_type":"feed_native","insertion_frequency":6,"start_after":6,"max_per_page":4,"card_size":"300x250"}'::jsonb
  ),
  (
    'home_mobile_inline_300x100',
    'Home Mobile Inline Banner 300x100',
    'home',
    'mobile_inline',
    300,
    100,
    '300x100',
    'custom',
    'juicyads',
    NULL,
    NULL,
    true,
    false,
    'custom_first',
    false,
    11,
    'mobile',
    8,
    '{"placement_type":"mobile_inline","insertion_frequency":8,"start_after":4,"max_per_page":3,"card_size":"300x100"}'::jsonb
  ),
  (
    'home_bottom_900x250',
    'Home Bottom Banner 900x250',
    'home',
    'homepage_bottom',
    900,
    250,
    '900x250',
    'custom',
    'juicyads',
    NULL,
    NULL,
    true,
    false,
    'custom_only',
    false,
    13,
    'all',
    0,
    '{"placement_type":"homepage_bottom"}'::jsonb
  ),
  (
    'category_feed_native',
    'Category Feed Native Card',
    'category',
    'category_feed',
    300,
    250,
    '300x250',
    'custom',
    'juicyads',
    NULL,
    NULL,
    true,
    false,
    'custom_first',
    false,
    80,
    'all',
    8,
    '{"placement_type":"category_feed","insertion_frequency":8,"start_after":6,"max_per_page":3,"card_size":"300x250"}'::jsonb
  )
ON CONFLICT (slot_key) DO UPDATE SET
  name = EXCLUDED.name,
  page = EXCLUDED.page,
  location = EXCLUDED.location,
  width = EXCLUDED.width,
  height = EXCLUDED.height,
  size_label = EXCLUDED.size_label,
  provider_type = EXCLUDED.provider_type,
  provider_id = EXCLUDED.provider_id,
  custom_enabled = EXCLUDED.custom_enabled,
  third_party_enabled = EXCLUDED.third_party_enabled,
  display_mode = EXCLUDED.display_mode,
  priority = EXCLUDED.priority,
  device_target = EXCLUDED.device_target,
  frequency_cap = EXCLUDED.frequency_cap,
  config = ad_slots.config || EXCLUDED.config,
  updated_at = now();

INSERT INTO public.platform_settings (key, value, section, description, value_type)
VALUES
  ('homepage_feed_layout_enabled', 'true', 'Monetization', 'Return backend-structured homepage feed layout with admin-managed ad slots', 'toggle'),
  ('ad_feed_ads_enabled', 'true', 'Monetization', 'Allow native in-feed ad slots when enabled by admin placement rules', 'toggle'),
  ('ad_allowed_placements', '["homepage_banner","homepage_top","homepage_bottom","sidebar","feed","feed_native","mobile_inline","category_feed","video_page","sticky_banner","native_card","before_footer"]', 'Monetization', 'Approved admin ad placement keys', 'json')
ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value,
  section = EXCLUDED.section,
  description = EXCLUDED.description,
  value_type = EXCLUDED.value_type;
