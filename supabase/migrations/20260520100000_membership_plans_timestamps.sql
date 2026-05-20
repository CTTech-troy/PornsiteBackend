-- membership_plans timestamps used by the admin membership plan UI.
-- Safe to run multiple times on older databases.

ALTER TABLE IF EXISTS public.membership_plans
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
