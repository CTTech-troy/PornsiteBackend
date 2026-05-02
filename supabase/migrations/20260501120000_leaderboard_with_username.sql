-- Update get_stream_leaderboard to include sender username so the frontend
-- can display names instead of raw sender_id UIDs.
create or replace function public.get_stream_leaderboard(p_stream_id text, p_limit int default 20)
returns table (sender_id text, sender_username text, total_sent numeric, donation_count bigint)
language sql
security definer
set search_path = public
as $$
  select
    t.sender_id,
    u.username as sender_username,
    sum(t.amount)::numeric as total_sent,
    count(*)::bigint as donation_count
  from public.stream_donations t
  left join public.users u on u.id = t.sender_id
  group by t.sender_id, u.username
  order by sum(t.amount) desc
  limit greatest(1, least(p_limit, 100))
$$;

revoke all on function public.get_stream_leaderboard(text, int) from public;
grant execute on function public.get_stream_leaderboard(text, int) to service_role;
