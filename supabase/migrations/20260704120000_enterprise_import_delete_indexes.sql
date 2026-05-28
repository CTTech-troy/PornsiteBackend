do $$
begin
  if to_regclass('public.videos') is not null then
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'videos' and column_name = 'import_job_id'
    ) then
      execute 'create index if not exists idx_videos_import_job_delete_not_null on public.videos (import_job_id) where import_job_id is not null';
    end if;

    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'videos' and column_name = 'source_row_number'
    ) then
      execute 'create index if not exists idx_videos_source_row_delete_not_null on public.videos (source_row_number) where source_row_number is not null';
    end if;

    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'videos' and column_name = 'playback_type'
    ) then
      execute 'create index if not exists idx_videos_external_playback_delete on public.videos (playback_type, id) where playback_type in (''external_embed'', ''external_redirect'')';
    end if;

    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'videos' and column_name = 'video_url'
    ) and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'videos' and column_name = 'iframe_embed'
    ) then
      execute 'create index if not exists idx_videos_empty_legacy_import_delete on public.videos (id) where video_url is null and iframe_embed is null';
    end if;
  end if;
end $$;

notify pgrst, 'reload schema';
