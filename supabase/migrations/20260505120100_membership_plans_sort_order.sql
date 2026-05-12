-- membership_plans.sort_order (used by membershipPlans.controller.js). Idempotent.

ALTER TABLE IF EXISTS public.membership_plans
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;
