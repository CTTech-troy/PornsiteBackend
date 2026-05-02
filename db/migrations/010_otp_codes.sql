-- OTP codes table for email-based one-time passwords (login, signup, password reset)
CREATE TABLE IF NOT EXISTS otp_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    text        NOT NULL,
  email      text        NOT NULL,
  otp_hash   text        NOT NULL,
  purpose    text        NOT NULL DEFAULT 'login',  -- 'login' | 'signup' | 'password_reset'
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Fast lookup by email + hash for verification
CREATE INDEX IF NOT EXISTS idx_otp_codes_email_hash    ON otp_codes (email, otp_hash);
-- Fast lookup of pending OTPs by user for invalidation
CREATE INDEX IF NOT EXISTS idx_otp_codes_user_pending  ON otp_codes (user_id, purpose) WHERE used_at IS NULL;

-- Row-level security: service role only (backend uses service role key)
ALTER TABLE otp_codes ENABLE ROW LEVEL SECURITY;

-- Allow only the service role to read/write (no public access)
CREATE POLICY "service_role_only" ON otp_codes
  USING (auth.role() = 'service_role');

-- Auto-clean expired rows older than 1 hour to keep the table small
-- Supabase pg_cron alternative: a manual purge via DELETE WHERE expires_at < now() - interval '1 hour'
