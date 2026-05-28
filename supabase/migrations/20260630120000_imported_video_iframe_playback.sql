alter table if exists public.videos
  add column if not exists iframe_embed text;

alter table if exists public.videos
  add column if not exists playback_type text;

update public.videos
set playback_type = case
  when iframe_embed is not null and btrim(iframe_embed) <> '' then 'external_embed'
  when video_url ~* '\.(mp4|m4v|mov|webm|ogg|ogv|m3u8)(\?|#|$)' then 'internal'
  else 'external_redirect'
end
where playback_type is null or playback_type = '';

alter table if exists public.videos
  alter column playback_type set default 'external_redirect';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'videos_playback_type_check'
      and conrelid = 'public.videos'::regclass
  ) then
    alter table public.videos
      add constraint videos_playback_type_check
      check (playback_type in ('internal', 'external_embed', 'external_redirect'));
  end if;
end $$;

create index if not exists idx_videos_playback_type_created
  on public.videos(playback_type, created_at desc);

create index if not exists idx_videos_iframe_embed_present
  on public.videos(created_at desc)
  where iframe_embed is not null and btrim(iframe_embed) <> '';

notify pgrst, 'reload schema';
