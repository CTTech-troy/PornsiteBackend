ALTER TABLE IF EXISTS public.users
  ADD COLUMN IF NOT EXISTS full_name text,
  ADD COLUMN IF NOT EXISTS avatar text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

UPDATE public.users u
SET
  avatar = COALESCE(NULLIF(trim(u.avatar), ''), u.avatar_url),
  avatar_url = COALESCE(NULLIF(trim(u.avatar_url), ''), u.avatar, u.avatar_url),
  full_name = COALESCE(NULLIF(trim(u.full_name), ''), u.display_name, u.username),
  display_name = COALESCE(NULLIF(trim(u.display_name), ''), u.full_name, u.username)
WHERE true;
