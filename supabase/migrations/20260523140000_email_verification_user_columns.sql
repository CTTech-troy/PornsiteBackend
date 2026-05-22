-- Ensure deployed schemas have the columns used by the verification flow.
-- Existing accounts stay grandfathered as verified; new signups explicitly set false.
alter table public.users
  add column if not exists email_verified boolean not null default true;

alter table public.users
  add column if not exists email_verified_at timestamptz;
