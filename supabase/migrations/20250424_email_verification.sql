-- Email verification: add email_verified columns to users and create token table.
-- DEFAULT true so existing users are grandfathered as verified; new signups
-- are explicitly inserted with email_verified = false.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT true;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

-- Stores hashed one-time verification tokens (raw token travels only in email).
CREATE TABLE IF NOT EXISTS public.email_verification_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evt_user_id
  ON public.email_verification_tokens(user_id);

CREATE INDEX IF NOT EXISTS idx_evt_token_hash
  ON public.email_verification_tokens(token_hash);
