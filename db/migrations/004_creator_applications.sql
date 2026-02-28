-- 004_creator_applications.sql
-- Stores creator applications; sensitive fields in data are encrypted at rest.
CREATE TABLE IF NOT EXISTS creator_applications (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_creator_applications_user_id ON creator_applications(user_id);
CREATE INDEX IF NOT EXISTS idx_creator_applications_status ON creator_applications(status);
