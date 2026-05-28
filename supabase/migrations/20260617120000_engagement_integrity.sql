-- Engagement integrity hardening:
-- - likes are idempotent per user/video
-- - views are counted only after meaningful playback and once per cooldown
-- - comments are inserted/edited/deleted atomically with spam guards
-- - creator subscriptions are toggled through a single unique row

create extension if not exists pgcrypto;

alter table if exists public.users
  add column if not exists followers integer not null default 0,
  add column if not exists following integer not null default 0;

alter table if exists public.tiktok_videos
  alter column likes_count set default 0,
  alter column comments_count set default 0,
  alter column views_count set default 0;

update public.tiktok_videos
   set likes_count = coalesce(likes_count, 0),
       comments_count = coalesce(comments_count, 0),
       views_count = coalesce(views_count, 0);

create unique index if not exists idx_tiktok_video_likes_user_video_unique
  on public.tiktok_video_likes (user_id, video_id);

alter table if exists public.tiktok_video_views
  add column if not exists viewer_key text,
  add column if not exists fingerprint text,
  add column if not exists ip_hash text,
  add column if not exists user_agent_hash text,
  add column if not exists qualified_watch_seconds integer not null default 0,
  add column if not exists progress_ratio numeric(6, 4) not null default 0,
  add column if not exists cooldown_window_start timestamptz;

update public.tiktok_video_views
   set viewer_key = coalesce(
         viewer_key,
         case
           when user_id is not null then 'u:' || user_id
           when session_id is not null then 's:' || session_id
           else 'legacy:' || id::text
         end
       ),
       cooldown_window_start = coalesce(cooldown_window_start, created_at)
 where viewer_key is null
    or cooldown_window_start is null;

drop index if exists public.idx_tiktok_video_views_unique_user;
drop index if exists public.idx_tiktok_video_views_unique_session;

create index if not exists idx_tiktok_video_views_identity_recent
  on public.tiktok_video_views (video_id, viewer_key, created_at desc);

create index if not exists idx_tiktok_video_views_video_created
  on public.tiktok_video_views (video_id, created_at desc);

alter table if exists public.tiktok_video_comments
  add column if not exists author_name text,
  add column if not exists parent_comment_id uuid,
  add column if not exists updated_at timestamptz,
  add column if not exists edited_at timestamptz,
  add column if not exists deleted_at timestamptz,
  add column if not exists status text not null default 'visible',
  add column if not exists moderation_status text not null default 'approved',
  add column if not exists comment_hash text,
  add column if not exists dedupe_bucket timestamptz;

update public.tiktok_video_comments
   set comment_hash = coalesce(
         comment_hash,
         encode(digest(lower(regexp_replace(btrim(coalesce(comment, '')), '[[:space:]]+', ' ', 'g')), 'sha256'), 'hex')
       ),
       dedupe_bucket = coalesce(dedupe_bucket, created_at),
       status = coalesce(nullif(status, ''), 'visible'),
       moderation_status = coalesce(nullif(moderation_status, ''), 'approved');

alter table if exists public.tiktok_video_comments
  alter column dedupe_bucket set default date_trunc('minute', now());

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'tiktok_video_comments_parent_fk'
       and conrelid = 'public.tiktok_video_comments'::regclass
  ) then
    alter table public.tiktok_video_comments
      add constraint tiktok_video_comments_parent_fk
      foreign key (parent_comment_id)
      references public.tiktok_video_comments(id)
      on delete cascade;
  end if;
end $$;

create index if not exists idx_tiktok_video_comments_visible_video
  on public.tiktok_video_comments (video_id, created_at)
  where deleted_at is null and status = 'visible';

create index if not exists idx_tiktok_video_comments_parent
  on public.tiktok_video_comments (parent_comment_id, created_at)
  where parent_comment_id is not null and deleted_at is null;

create unique index if not exists idx_tiktok_video_comments_dedupe_minute
  on public.tiktok_video_comments (video_id, user_id, comment_hash, dedupe_bucket)
  where deleted_at is null and comment_hash is not null;

create table if not exists public.creator_subscriptions (
  id uuid primary key default gen_random_uuid(),
  subscriber_user_id text not null,
  creator_id text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unsubscribed_at timestamptz,
  constraint creator_subscriptions_no_self check (subscriber_user_id <> creator_id)
);

create unique index if not exists idx_creator_subscriptions_unique_pair
  on public.creator_subscriptions (subscriber_user_id, creator_id);

create index if not exists idx_creator_subscriptions_creator_active
  on public.creator_subscriptions (creator_id, created_at desc)
  where status = 'active';

create index if not exists idx_creator_subscriptions_subscriber_active
  on public.creator_subscriptions (subscriber_user_id, created_at desc)
  where status = 'active';

drop function if exists public.like_video(uuid, text);
create or replace function public.like_video(p_video_id uuid, p_user_id text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_inserted integer := 0;
  v_count bigint := 0;
begin
  if p_user_id is null or btrim(p_user_id) = '' then
    raise exception 'p_user_id is required';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_video_id::text), hashtext('like:' || p_user_id));

  insert into public.tiktok_video_likes (video_id, user_id)
  values (p_video_id, p_user_id)
  on conflict do nothing
  returning 1 into v_inserted;

  update public.tiktok_videos
     set likes_count = (
       select count(*) from public.tiktok_video_likes where video_id = p_video_id
     )
   where video_id = p_video_id
   returning likes_count into v_count;

  return jsonb_build_object(
    'liked', true,
    'total_likes', coalesce(v_count, 0),
    'duplicate', coalesce(v_inserted, 0) = 0,
    'counted', coalesce(v_inserted, 0) = 1
  );
end;
$$;

drop function if exists public.unlike_video(uuid, text);
create or replace function public.unlike_video(p_video_id uuid, p_user_id text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_deleted integer := 0;
  v_count bigint := 0;
begin
  if p_user_id is null or btrim(p_user_id) = '' then
    raise exception 'p_user_id is required';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_video_id::text), hashtext('like:' || p_user_id));

  delete from public.tiktok_video_likes
   where video_id = p_video_id
     and user_id = p_user_id
  returning 1 into v_deleted;

  update public.tiktok_videos
     set likes_count = (
       select count(*) from public.tiktok_video_likes where video_id = p_video_id
     )
   where video_id = p_video_id
   returning likes_count into v_count;

  return jsonb_build_object(
    'liked', false,
    'total_likes', coalesce(v_count, 0),
    'duplicate', coalesce(v_deleted, 0) = 0,
    'counted', coalesce(v_deleted, 0) = 1
  );
end;
$$;

drop function if exists public.record_video_view(uuid, text, text);
drop function if exists public.record_video_view(uuid, text, text, text, text, integer, numeric, integer);
create or replace function public.record_video_view(
  p_video_id uuid,
  p_user_id text,
  p_session_id text,
  p_fingerprint text default null,
  p_ip_hash text default null,
  p_watch_seconds integer default 0,
  p_progress_ratio numeric default 0,
  p_cooldown_days integer default 14
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_identity text;
  v_session text := nullif(left(btrim(coalesce(p_session_id, '')), 128), '');
  v_fingerprint text := nullif(left(btrim(coalesce(p_fingerprint, '')), 160), '');
  v_ip_hash text := nullif(left(btrim(coalesce(p_ip_hash, '')), 160), '');
  v_watch_seconds integer := greatest(coalesce(p_watch_seconds, 0), 0);
  v_progress numeric := least(greatest(coalesce(p_progress_ratio, 0), 0), 1);
  v_cooldown_days integer := greatest(coalesce(p_cooldown_days, 14), 1);
  v_latest timestamptz;
  v_count bigint := 0;
begin
  select views_count into v_count
    from public.tiktok_videos
   where video_id = p_video_id;

  if v_count is null then
    return jsonb_build_object('success', false, 'views', 0, 'duplicate', true, 'counted', false, 'reason', 'video_not_found');
  end if;

  if v_watch_seconds < 10 and v_progress < 0.20 then
    return jsonb_build_object('success', true, 'views', coalesce(v_count, 0), 'duplicate', true, 'counted', false, 'qualified', false);
  end if;

  v_identity := case
    when p_user_id is not null and btrim(p_user_id) <> '' then 'u:' || btrim(p_user_id)
    when v_fingerprint is not null then 'fp:' || v_fingerprint
    when v_session is not null then 's:' || v_session
    when v_ip_hash is not null then 'ip:' || v_ip_hash
    else null
  end;

  if v_identity is null then
    return jsonb_build_object('success', true, 'views', coalesce(v_count, 0), 'duplicate', true, 'counted', false, 'reason', 'missing_viewer_identity');
  end if;

  perform pg_advisory_xact_lock(hashtext(p_video_id::text), hashtext('view:' || v_identity));

  select created_at into v_latest
    from public.tiktok_video_views
   where video_id = p_video_id
     and viewer_key = v_identity
   order by created_at desc
   limit 1;

  if v_latest is not null and v_latest > now() - make_interval(days => v_cooldown_days) then
    return jsonb_build_object(
      'success', true,
      'views', coalesce(v_count, 0),
      'duplicate', true,
      'counted', false,
      'qualified', true,
      'cooldownUntil', v_latest + make_interval(days => v_cooldown_days)
    );
  end if;

  insert into public.tiktok_video_views (
    video_id,
    user_id,
    session_id,
    viewer_key,
    fingerprint,
    ip_hash,
    qualified_watch_seconds,
    progress_ratio,
    cooldown_window_start
  )
  values (
    p_video_id,
    nullif(btrim(coalesce(p_user_id, '')), ''),
    case when p_user_id is null or btrim(coalesce(p_user_id, '')) = '' then coalesce(v_session, v_fingerprint, v_ip_hash) else null end,
    v_identity,
    v_fingerprint,
    v_ip_hash,
    v_watch_seconds,
    v_progress,
    now()
  );

  update public.tiktok_videos
     set views_count = (
       select count(*) from public.tiktok_video_views where video_id = p_video_id
     )
   where video_id = p_video_id
   returning views_count into v_count;

  return jsonb_build_object(
    'success', true,
    'views', coalesce(v_count, 0),
    'duplicate', false,
    'counted', true,
    'qualified', true
  );
end;
$$;

drop function if exists public.add_video_comment(uuid, text, text, text, uuid);
create or replace function public.add_video_comment(
  p_video_id uuid,
  p_user_id text,
  p_comment text,
  p_author_name text default 'Member',
  p_parent_comment_id uuid default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_text text := regexp_replace(btrim(coalesce(p_comment, '')), '[[:space:]]+', ' ', 'g');
  v_author text := left(nullif(btrim(coalesce(p_author_name, '')), ''), 64);
  v_hash text;
  v_existing public.tiktok_video_comments%rowtype;
  v_inserted public.tiktok_video_comments%rowtype;
  v_count bigint := 0;
begin
  if p_user_id is null or btrim(p_user_id) = '' then
    raise exception 'p_user_id is required';
  end if;
  if v_text = '' then
    raise exception 'Comment text is required';
  end if;
  if char_length(v_text) > 1000 then
    raise exception 'Comment is too long';
  end if;
  if p_parent_comment_id is not null and not exists (
    select 1
      from public.tiktok_video_comments
     where id = p_parent_comment_id
       and video_id = p_video_id
       and deleted_at is null
       and status = 'visible'
  ) then
    raise exception 'Parent comment not found';
  end if;

  v_author := coalesce(v_author, 'Member');
  v_hash := encode(digest(lower(v_text), 'sha256'), 'hex');

  perform pg_advisory_xact_lock(hashtext(p_video_id::text), hashtext('comment:' || p_user_id));

  select * into v_existing
    from public.tiktok_video_comments
   where video_id = p_video_id
     and user_id = p_user_id
     and comment_hash = v_hash
     and deleted_at is null
     and created_at > now() - interval '60 seconds'
   order by created_at desc
   limit 1;

  if v_existing.id is not null then
    select count(*) into v_count
      from public.tiktok_video_comments
     where video_id = p_video_id
       and deleted_at is null
       and status = 'visible';

    return jsonb_build_object(
      'duplicate', true,
      'total_comments', coalesce(v_count, 0),
      'comment', jsonb_build_object(
        'commentId', v_existing.id,
        'userId', v_existing.user_id,
        'authorName', coalesce(v_existing.author_name, 'Member'),
        'text', v_existing.comment,
        'createdAt', extract(epoch from v_existing.created_at) * 1000,
        'parentCommentId', v_existing.parent_comment_id
      )
    );
  end if;

  insert into public.tiktok_video_comments (
    video_id,
    user_id,
    author_name,
    comment,
    parent_comment_id,
    comment_hash,
    dedupe_bucket,
    status,
    moderation_status,
    updated_at
  )
  values (
    p_video_id,
    p_user_id,
    v_author,
    v_text,
    p_parent_comment_id,
    v_hash,
    date_trunc('minute', now()),
    'visible',
    'approved',
    now()
  )
  returning * into v_inserted;

  update public.tiktok_videos
     set comments_count = (
       select count(*)
         from public.tiktok_video_comments
        where video_id = p_video_id
          and deleted_at is null
          and status = 'visible'
     )
   where video_id = p_video_id
   returning comments_count into v_count;

  return jsonb_build_object(
    'duplicate', false,
    'total_comments', coalesce(v_count, 0),
    'comment', jsonb_build_object(
      'commentId', v_inserted.id,
      'userId', v_inserted.user_id,
      'authorName', coalesce(v_inserted.author_name, 'Member'),
      'text', v_inserted.comment,
      'createdAt', extract(epoch from v_inserted.created_at) * 1000,
      'parentCommentId', v_inserted.parent_comment_id
    )
  );
end;
$$;

drop function if exists public.update_video_comment(uuid, uuid, text, text);
create or replace function public.update_video_comment(
  p_video_id uuid,
  p_comment_id uuid,
  p_user_id text,
  p_comment text
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_text text := regexp_replace(btrim(coalesce(p_comment, '')), '[[:space:]]+', ' ', 'g');
  v_hash text;
  v_row public.tiktok_video_comments%rowtype;
begin
  if v_text = '' then
    raise exception 'Comment text is required';
  end if;
  if char_length(v_text) > 1000 then
    raise exception 'Comment is too long';
  end if;

  v_hash := encode(digest(lower(v_text), 'sha256'), 'hex');

  update public.tiktok_video_comments
     set comment = v_text,
         comment_hash = v_hash,
         edited_at = now(),
         updated_at = now()
   where id = p_comment_id
     and video_id = p_video_id
     and user_id = p_user_id
     and deleted_at is null
     and status = 'visible'
   returning * into v_row;

  if v_row.id is null then
    return jsonb_build_object('success', false, 'reason', 'not_found');
  end if;

  return jsonb_build_object(
    'success', true,
    'comment', jsonb_build_object(
      'commentId', v_row.id,
      'userId', v_row.user_id,
      'authorName', coalesce(v_row.author_name, 'Member'),
      'text', v_row.comment,
      'createdAt', extract(epoch from v_row.created_at) * 1000,
      'editedAt', extract(epoch from v_row.edited_at) * 1000,
      'parentCommentId', v_row.parent_comment_id
    )
  );
end;
$$;

drop function if exists public.delete_video_comment(uuid, uuid, text);
create or replace function public.delete_video_comment(
  p_video_id uuid,
  p_comment_id uuid,
  p_user_id text
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_row public.tiktok_video_comments%rowtype;
  v_count bigint := 0;
begin
  update public.tiktok_video_comments
     set deleted_at = now(),
         status = 'deleted',
         updated_at = now()
   where id = p_comment_id
     and video_id = p_video_id
     and user_id = p_user_id
     and deleted_at is null
   returning * into v_row;

  if v_row.id is null then
    return jsonb_build_object('success', false, 'reason', 'not_found');
  end if;

  update public.tiktok_videos
     set comments_count = (
       select count(*)
         from public.tiktok_video_comments
        where video_id = p_video_id
          and deleted_at is null
          and status = 'visible'
     )
   where video_id = p_video_id
   returning comments_count into v_count;

  return jsonb_build_object('success', true, 'total_comments', coalesce(v_count, 0));
end;
$$;

drop function if exists public.toggle_creator_subscription(text, text);
create or replace function public.toggle_creator_subscription(
  p_subscriber_user_id text,
  p_creator_id text
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_existing public.creator_subscriptions%rowtype;
  v_subscribed boolean := false;
  v_followers bigint := 0;
  v_following bigint := 0;
begin
  if p_subscriber_user_id is null or btrim(p_subscriber_user_id) = '' then
    raise exception 'subscriber user id is required';
  end if;
  if p_creator_id is null or btrim(p_creator_id) = '' then
    raise exception 'creator id is required';
  end if;
  if p_subscriber_user_id = p_creator_id then
    raise exception 'Users cannot subscribe to themselves';
  end if;

  perform pg_advisory_xact_lock(hashtext('creator-sub:' || p_creator_id), hashtext(p_subscriber_user_id));

  select * into v_existing
    from public.creator_subscriptions
   where subscriber_user_id = p_subscriber_user_id
     and creator_id = p_creator_id
   limit 1;

  if v_existing.id is null then
    insert into public.creator_subscriptions (subscriber_user_id, creator_id, status, updated_at)
    values (p_subscriber_user_id, p_creator_id, 'active', now());
    v_subscribed := true;
  elsif v_existing.status = 'active' then
    update public.creator_subscriptions
       set status = 'inactive',
           unsubscribed_at = now(),
           updated_at = now()
     where id = v_existing.id;
    v_subscribed := false;
  else
    update public.creator_subscriptions
       set status = 'active',
           unsubscribed_at = null,
           updated_at = now()
     where id = v_existing.id;
    v_subscribed := true;
  end if;

  select count(*) into v_followers
    from public.creator_subscriptions
   where creator_id = p_creator_id
     and status = 'active';

  select count(*) into v_following
    from public.creator_subscriptions
   where subscriber_user_id = p_subscriber_user_id
     and status = 'active';

  update public.users set followers = v_followers where id = p_creator_id;
  update public.users set following = v_following where id = p_subscriber_user_id;

  return jsonb_build_object(
    'subscribed', v_subscribed,
    'followers', coalesce(v_followers, 0),
    'following', coalesce(v_following, 0)
  );
end;
$$;

drop function if exists public.get_creator_subscription_status(text, text);
create or replace function public.get_creator_subscription_status(
  p_subscriber_user_id text,
  p_creator_id text
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_subscribed boolean := false;
  v_followers bigint := 0;
  v_following bigint := 0;
begin
  if p_creator_id is null or btrim(p_creator_id) = '' then
    return jsonb_build_object('subscribed', false, 'followers', 0, 'following', 0);
  end if;

  if p_subscriber_user_id is not null and btrim(p_subscriber_user_id) <> '' then
    select exists (
      select 1
        from public.creator_subscriptions
       where subscriber_user_id = p_subscriber_user_id
         and creator_id = p_creator_id
         and status = 'active'
    ) into v_subscribed;
  end if;

  select count(*) into v_followers
    from public.creator_subscriptions
   where creator_id = p_creator_id
     and status = 'active';

  if p_subscriber_user_id is not null and btrim(p_subscriber_user_id) <> '' then
    select count(*) into v_following
      from public.creator_subscriptions
     where subscriber_user_id = p_subscriber_user_id
       and status = 'active';
  end if;

  return jsonb_build_object(
    'subscribed', coalesce(v_subscribed, false),
    'followers', coalesce(v_followers, 0),
    'following', coalesce(v_following, 0)
  );
end;
$$;

revoke all on function public.like_video(uuid, text) from public;
revoke all on function public.unlike_video(uuid, text) from public;
revoke all on function public.record_video_view(uuid, text, text, text, text, integer, numeric, integer) from public;
revoke all on function public.add_video_comment(uuid, text, text, text, uuid) from public;
revoke all on function public.update_video_comment(uuid, uuid, text, text) from public;
revoke all on function public.delete_video_comment(uuid, uuid, text) from public;
revoke all on function public.toggle_creator_subscription(text, text) from public;
revoke all on function public.get_creator_subscription_status(text, text) from public;

grant execute on function public.like_video(uuid, text) to service_role;
grant execute on function public.unlike_video(uuid, text) to service_role;
grant execute on function public.record_video_view(uuid, text, text, text, text, integer, numeric, integer) to service_role;
grant execute on function public.add_video_comment(uuid, text, text, text, uuid) to service_role;
grant execute on function public.update_video_comment(uuid, uuid, text, text) to service_role;
grant execute on function public.delete_video_comment(uuid, uuid, text) to service_role;
grant execute on function public.toggle_creator_subscription(text, text) to service_role;
grant execute on function public.get_creator_subscription_status(text, text) to service_role;
