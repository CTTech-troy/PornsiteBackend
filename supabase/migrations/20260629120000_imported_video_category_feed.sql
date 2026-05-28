do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'videos'
      and column_name = 'category'
  ) and exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'videos'
      and column_name = 'created_at'
  ) then
    execute 'create index if not exists idx_videos_imported_category_created_desc on public.videos (category, created_at desc) where category is not null';
  end if;
end $$;

create or replace function public.get_imported_video_categories(p_limit integer default 200)
returns table (
  value text,
  label text,
  id text,
  video_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with normalized as (
    select lower(regexp_replace(trim(category), '[\s-]+', '_', 'g')) as value
    from public.videos
    where category is not null
      and trim(category) <> ''
  )
  select
    value,
    initcap(replace(value, '_', ' ')) as label,
    regexp_replace(replace(value, '_', '-'), '[^a-z0-9-]+', '-', 'g') as id,
    count(*) as video_count
  from normalized
  where value <> ''
  group by value
  order by count(*) desc, label asc
  limit greatest(1, least(coalesce(p_limit, 200), 500));
$$;

grant execute on function public.get_imported_video_categories(integer) to anon, authenticated, service_role;
