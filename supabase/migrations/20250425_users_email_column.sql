-- Add email column to users table (needed for verification flow).
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS email text;
