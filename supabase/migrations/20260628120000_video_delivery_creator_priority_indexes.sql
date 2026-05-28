-- Fast creator-first video delivery for homepage, category, creator, search,
-- and hover-thumbnail reads. Blocks are defensive so older environments can
-- apply the migration even when some legacy columns are missing.

create extension if not exists pg_trgm;

alter table if exists public.videos
  add column if not exists creator_id text;

do $$
begin
  if to_regclass('public.videos') is not null then
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'videos' and column_name = 'created_at') then
      execute 'create index if not exists idx_videos_created_at_desc on public.videos (created_at desc)';
      execute 'create index if not exists idx_videos_creator_priority_feed on public.videos ((case when creator_id is not null then 0 else 1 end), created_at desc)';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'videos' and column_name = 'creator_id')
       and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'videos' and column_name = 'created_at') then
      execute 'create index if not exists idx_videos_creator_created_desc on public.videos (creator_id, created_at desc) where creator_id is not null';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'videos' and column_name = 'category')
       and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'videos' and column_name = 'created_at') then
      execute 'create index if not exists idx_videos_category_created_desc on public.videos (category, created_at desc) where category is not null';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'videos' and column_name = 'publish_date') then
      execute 'create index if not exists idx_videos_publish_date_desc on public.videos (publish_date desc) where publish_date is not null';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'videos' and column_name = 'title') then
      execute 'create index if not exists idx_videos_title_trgm on public.videos using gin (title gin_trgm_ops)';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'videos' and column_name = 'video_url') then
      execute 'create index if not exists idx_videos_video_url_hash on public.videos using hash (video_url)';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'videos' and column_name = 'thumbnail_url') then
      execute 'create index if not exists idx_videos_thumbnail_url_hash on public.videos using hash (thumbnail_url) where thumbnail_url is not null';
    end if;
  end if;
end $$;

do $$
begin
  if to_regclass('public.tiktok_videos') is not null then
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tiktok_videos' and column_name = 'user_id')
       and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tiktok_videos' and column_name = 'created_at') then
      execute 'create index if not exists idx_tiktok_videos_creator_created_desc on public.tiktok_videos (user_id, created_at desc) where user_id is not null';
      execute 'create index if not exists idx_tiktok_videos_creator_priority_feed on public.tiktok_videos ((case when user_id is not null then 0 else 1 end), created_at desc)';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tiktok_videos' and column_name = 'main_orientation_category')
       and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tiktok_videos' and column_name = 'created_at') then
      execute 'create index if not exists idx_tiktok_videos_category_created_desc on public.tiktok_videos (main_orientation_category, created_at desc) where main_orientation_category is not null';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tiktok_videos' and column_name = 'title') then
      execute 'create index if not exists idx_tiktok_videos_title_trgm on public.tiktok_videos using gin (title gin_trgm_ops)';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tiktok_videos' and column_name = 'storage_url') then
      execute 'create index if not exists idx_tiktok_videos_storage_url_hash on public.tiktok_videos using hash (storage_url) where storage_url is not null';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tiktok_videos' and column_name = 'stream_url') then
      execute 'create index if not exists idx_tiktok_videos_stream_url_hash on public.tiktok_videos using hash (stream_url) where stream_url is not null';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tiktok_videos' and column_name = 'thumbnail_url') then
      execute 'create index if not exists idx_tiktok_videos_thumbnail_url_hash on public.tiktok_videos using hash (thumbnail_url) where thumbnail_url is not null';
    end if;
  end if;
end $$;
