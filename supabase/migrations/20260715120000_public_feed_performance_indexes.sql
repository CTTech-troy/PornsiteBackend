create extension if not exists pg_trgm;

do $$
begin
  if to_regclass('public.tiktok_videos') is not null then
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tiktok_videos' and column_name = 'deleted_at') then
      execute 'create index if not exists idx_tiktok_videos_deleted_null_created on public.tiktok_videos (created_at desc) where deleted_at is null';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tiktok_videos' and column_name = 'status')
       and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tiktok_videos' and column_name = 'is_live')
       and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tiktok_videos' and column_name = 'created_at') then
      execute 'create index if not exists idx_tiktok_videos_public_status_created on public.tiktok_videos (status, is_live, created_at desc)';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tiktok_videos' and column_name = 'visibility')
       and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tiktok_videos' and column_name = 'status')
       and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tiktok_videos' and column_name = 'is_live')
       and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tiktok_videos' and column_name = 'created_at') then
      execute 'create index if not exists idx_tiktok_videos_visibility_status_created on public.tiktok_videos (visibility, status, is_live, created_at desc)';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tiktok_videos' and column_name = 'is_premium_content')
       and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tiktok_videos' and column_name = 'created_at') then
      execute 'create index if not exists idx_tiktok_videos_premium_created on public.tiktok_videos (is_premium_content, created_at desc)';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tiktok_videos' and column_name = 'content_source')
       and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tiktok_videos' and column_name = 'created_at') then
      execute 'create index if not exists idx_tiktok_videos_content_source_created on public.tiktok_videos (content_source, created_at desc)';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tiktok_videos' and column_name = 'main_orientation_category')
       and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tiktok_videos' and column_name = 'created_at') then
      execute 'create index if not exists idx_tiktok_videos_category_lower_created on public.tiktok_videos (lower(main_orientation_category), created_at desc) where main_orientation_category is not null';
      execute 'create index if not exists idx_tiktok_videos_category_trgm_perf on public.tiktok_videos using gin (main_orientation_category gin_trgm_ops)';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tiktok_videos' and column_name = 'tags') then
      execute 'create index if not exists idx_tiktok_videos_tags_gin_perf on public.tiktok_videos using gin (tags)';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tiktok_videos' and column_name = 'description') then
      execute 'create index if not exists idx_tiktok_videos_description_trgm on public.tiktok_videos using gin (description gin_trgm_ops)';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tiktok_videos' and column_name = 'creator_display_name') then
      execute 'create index if not exists idx_tiktok_videos_creator_display_trgm on public.tiktok_videos using gin (creator_display_name gin_trgm_ops)';
    end if;
  end if;
end $$;

do $$
begin
  if to_regclass('public.videos') is not null then
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'videos' and column_name = 'deleted_at')
       and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'videos' and column_name = 'created_at') then
      execute 'create index if not exists idx_videos_not_deleted_created on public.videos (created_at desc) where deleted_at is null';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'videos' and column_name = 'category')
       and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'videos' and column_name = 'created_at') then
      execute 'create index if not exists idx_videos_category_lower_created on public.videos (lower(category), created_at desc) where category is not null';
      execute 'create index if not exists idx_videos_category_trgm_perf on public.videos using gin (category gin_trgm_ops)';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'videos' and column_name = 'views')
       and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'videos' and column_name = 'created_at') then
      execute 'create index if not exists idx_videos_views_created on public.videos (views desc, created_at desc)';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'videos' and column_name = 'description') then
      execute 'create index if not exists idx_videos_description_trgm on public.videos using gin (description gin_trgm_ops)';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'videos' and column_name = 'studio') then
      execute 'create index if not exists idx_videos_studio_trgm on public.videos using gin (studio gin_trgm_ops)';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'videos' and column_name = 'actors') then
      execute 'create index if not exists idx_videos_actors_gin_perf on public.videos using gin (actors)';
    end if;
  end if;
end $$;

do $$
begin
  if to_regclass('public.media') is not null then
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'media' and column_name = 'type')
       and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'media' and column_name = 'created_at') then
      execute 'create index if not exists idx_media_type_created_desc on public.media (type, created_at desc)';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'media' and column_name = 'category')
       and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'media' and column_name = 'created_at') then
      execute 'create index if not exists idx_media_category_lower_created on public.media (lower(category), created_at desc) where category is not null';
      execute 'create index if not exists idx_media_category_trgm_perf on public.media using gin (category gin_trgm_ops)';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'media' and column_name = 'is_premium_content')
       and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'media' and column_name = 'created_at') then
      execute 'create index if not exists idx_media_premium_created_desc on public.media (is_premium_content, created_at desc)';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'media' and column_name = 'user_id')
       and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'media' and column_name = 'created_at') then
      execute 'create index if not exists idx_media_user_created_desc on public.media (user_id, created_at desc) where user_id is not null';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'media' and column_name = 'title') then
      execute 'create index if not exists idx_media_title_trgm on public.media using gin (title gin_trgm_ops)';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'media' and column_name = 'description') then
      execute 'create index if not exists idx_media_description_trgm on public.media using gin (description gin_trgm_ops)';
    end if;
  end if;
end $$;

do $$
begin
  if to_regclass('public.creators') is not null then
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'creators' and column_name = 'creator_type')
       and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'creators' and column_name = 'created_at') then
      execute 'create index if not exists idx_creators_type_created_desc_perf on public.creators (creator_type, created_at desc)';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'creators' and column_name = 'active')
       and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'creators' and column_name = 'status')
       and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'creators' and column_name = 'creator_type')
       and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'creators' and column_name = 'created_at') then
      execute 'create index if not exists idx_creators_public_directory_perf on public.creators (creator_type, active, status, created_at desc)';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'creators' and column_name = 'display_name') then
      execute 'create index if not exists idx_creators_display_name_trgm on public.creators using gin (display_name gin_trgm_ops)';
    end if;
  end if;
end $$;

do $$
begin
  if to_regclass('public.users') is not null then
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'users' and column_name = 'display_name') then
      execute 'create index if not exists idx_users_display_name_trgm on public.users using gin (display_name gin_trgm_ops)';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'users' and column_name = 'followers') then
      execute 'create index if not exists idx_users_followers_desc on public.users (followers desc)';
    end if;
  end if;
end $$;

do $$
begin
  if to_regclass('public.video_search_queries') is not null then
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'video_search_queries' and column_name = 'query') then
      execute 'create index if not exists idx_video_search_queries_query_trgm on public.video_search_queries using gin (query gin_trgm_ops)';
      execute 'create index if not exists idx_video_search_queries_lower_query_pattern on public.video_search_queries (lower(query) text_pattern_ops)';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'video_search_queries' and column_name = 'created_at') then
      execute 'create index if not exists idx_video_search_queries_created_desc_perf on public.video_search_queries (created_at desc)';
    end if;
  end if;
end $$;
