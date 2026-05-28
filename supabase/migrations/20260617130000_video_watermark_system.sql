-- Permanent branded video watermark settings and metadata.

alter table if exists public.tiktok_videos
  add column if not exists watermark_required boolean not null default true,
  add column if not exists watermark_burned_in boolean not null default false,
  add column if not exists watermark_config jsonb not null default '{}'::jsonb,
  add column if not exists watermark_updated_at timestamptz;

do $$
begin
  if to_regclass('public.tiktok_videos') is not null then
    create index if not exists idx_tiktok_videos_watermark_pending
      on public.tiktok_videos(created_at desc)
      where watermark_required = true and watermark_burned_in = false;
  end if;
end $$;

do $$
begin
  if to_regclass('public.platform_settings') is not null then
    alter table public.platform_settings
      add column if not exists section text,
      add column if not exists description text,
      add column if not exists value_type text default 'text';

    insert into public.platform_settings (key, value, section, description, value_type)
    values
      ('video_watermark_enabled', 'true', 'Video Watermark', 'Display the branded video watermark across all playback surfaces.', 'toggle'),
      ('video_watermark_logo_url', '', 'Video Watermark', 'Primary transparent PNG/SVG watermark logo URL. Falls back to the platform logo.', 'url'),
      ('video_watermark_logo_url_dark', '', 'Video Watermark', 'Dark-mode watermark logo variant URL.', 'url'),
      ('video_watermark_logo_url_light', '', 'Video Watermark', 'Light-mode watermark logo variant URL.', 'url'),
      ('video_watermark_size_px', '92', 'Video Watermark', 'Desktop watermark width in pixels.', 'number'),
      ('video_watermark_opacity', '0.72', 'Video Watermark', 'Watermark opacity from 0.15 to 1.', 'number'),
      ('video_watermark_margin_px', '16', 'Video Watermark', 'Safe margin from the player edge in pixels.', 'number'),
      ('video_watermark_position', 'bottom-right', 'Video Watermark', 'Watermark anchor position.', 'select'),
      ('video_watermark_animation', 'none', 'Video Watermark', 'Optional subtle watermark animation.', 'select'),
      ('video_watermark_burn_in_enabled', 'true', 'Video Watermark', 'Require server/export pipelines to burn the watermark into exported assets.', 'toggle')
    on conflict (key) do nothing;
  end if;
end $$;
