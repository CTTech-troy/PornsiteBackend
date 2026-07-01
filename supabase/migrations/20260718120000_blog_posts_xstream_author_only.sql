delete from public.blog_posts
where coalesce(author_name, '') !~* 'xstream';

update public.blog_posts
set author_name = 'XstreamVideos Editorial Team',
    updated_at = now()
where coalesce(author_name, '') ~* 'xstream'
  and author_name <> 'XstreamVideos Editorial Team';

alter table public.blog_posts
  alter column author_name set default 'XstreamVideos Editorial Team';

alter table public.blog_posts
  drop constraint if exists blog_posts_author_name_xstream_only;

alter table public.blog_posts
  add constraint blog_posts_author_name_xstream_only
  check (author_name ~* 'xstream');

drop policy if exists "Public can read published blog posts" on public.blog_posts;
create policy "Public can read published blog posts"
on public.blog_posts
for select
using (status = 'published' and author_name ~* 'xstream');

create index if not exists idx_blog_posts_xstream_published
  on public.blog_posts (status, published_at desc, updated_at desc)
  where author_name ~* 'xstream';
