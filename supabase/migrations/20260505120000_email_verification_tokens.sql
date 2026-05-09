-- Email verification tokens (used by emailVerificationService.js). Idempotent.

CREATE TABLE IF NOT EXISTS public.email_verification_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  email text NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS email_verification_tokens_token_hash_key
  ON public.email_verification_tokens (token_hash);

CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user_unused_created
  ON public.email_verification_tokens (user_id, created_at DESC)
  WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_expires
  ON public.email_verification_tokens (expires_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE n.nspname = 'public'
      AND t.relname = 'email_verification_tokens'
      AND c.conname = 'email_verification_tokens_user_id_fkey'
  ) THEN
    ALTER TABLE public.email_verification_tokens
      ADD CONSTRAINT email_verification_tokens_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES public.users (id) ON DELETE CASCADE;
  END IF;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'email_verification_tokens FK skipped: referenced table missing';
  WHEN OTHERS THEN
    RAISE NOTICE 'email_verification_tokens FK skipped: %', SQLERRM;
END $$;

ALTER TABLE public.email_verification_tokens ENABLE ROW LEVEL SECURITY;
