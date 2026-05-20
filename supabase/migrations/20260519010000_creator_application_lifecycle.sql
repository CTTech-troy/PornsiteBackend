-- Creator application moderation lifecycle.
-- Adds explicit approval/rejection/ban/reconsider tracking and creator profile activation fields.

ALTER TABLE IF EXISTS public.users
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS creator_application_ban jsonb NOT NULL DEFAULT '{"banned":false}'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

ALTER TABLE IF EXISTS public.creators
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS application_id uuid,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

ALTER TABLE IF EXISTS public.creator_applications
  ADD COLUMN IF NOT EXISTS decision_at timestamptz,
  ADD COLUMN IF NOT EXISTS reconsidered_at timestamptz,
  ADD COLUMN IF NOT EXISTS update_token text,
  ADD COLUMN IF NOT EXISTS token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS missing_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS email_sent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ban_reason text,
  ADD COLUMN IF NOT EXISTS ban_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS ban_admin_id text;

CREATE INDEX IF NOT EXISTS idx_creator_applications_decision_at
  ON public.creator_applications(decision_at DESC)
  WHERE decision_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_creator_applications_ban_expires_at
  ON public.creator_applications(ban_expires_at)
  WHERE ban_expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_creator_application_ban
  ON public.users USING gin (creator_application_ban);

CREATE INDEX IF NOT EXISTS idx_creators_active_status
  ON public.creators(active, status);
