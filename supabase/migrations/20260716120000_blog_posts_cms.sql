create table if not exists public.blog_posts (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  summary text not null default '',
  category text not null default 'Platform updates',
  tags text[] not null default '{}',
  author_name text not null default 'XstreamVideos Editorial Team',
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  body_html text not null default '',
  body_text text not null default '',
  cover_image_url text,
  cover_image_alt text,
  video_url text,
  video_title text,
  seo jsonb not null default '{}'::jsonb,
  published_at timestamptz,
  archived_at timestamptz,
  created_by uuid,
  created_by_email text,
  updated_by uuid,
  updated_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_blog_posts_status_published
  on public.blog_posts (status, published_at desc, updated_at desc);

create index if not exists idx_blog_posts_slug
  on public.blog_posts (slug);

create index if not exists idx_blog_posts_category
  on public.blog_posts (category);

create index if not exists idx_blog_posts_updated_at
  on public.blog_posts (updated_at desc);

create index if not exists idx_blog_posts_tags
  on public.blog_posts using gin (tags);

create or replace function public.set_blog_posts_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_blog_posts_updated_at on public.blog_posts;
create trigger trg_blog_posts_updated_at
before update on public.blog_posts
for each row
execute function public.set_blog_posts_updated_at();

alter table public.blog_posts enable row level security;

drop policy if exists "Public can read published blog posts" on public.blog_posts;
create policy "Public can read published blog posts"
on public.blog_posts
for select
using (status = 'published');
