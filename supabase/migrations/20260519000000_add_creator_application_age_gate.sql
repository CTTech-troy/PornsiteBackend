-- Add DOB-based age gate metadata for the creator main application flow.

ALTER TABLE public.creators_main_application
  ADD COLUMN IF NOT EXISTS date_of_birth date,
  ADD COLUMN IF NOT EXISTS age_verified boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_creators_main_application_date_of_birth
  ON public.creators_main_application(date_of_birth);
