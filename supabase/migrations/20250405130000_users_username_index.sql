-- Lookup by username (e.g. profile search); Firebase UID remains primary key on public.users
CREATE INDEX IF NOT EXISTS idx_users_username_lower ON public.users (lower(username))
  WHERE username IS NOT NULL;
