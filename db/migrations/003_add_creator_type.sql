-- Add creator_type to distinguish channels from individual pstars.
-- Existing rows default to 'pstar'.

ALTER TABLE public.creators
  ADD COLUMN IF NOT EXISTS creator_type TEXT NOT NULL DEFAULT 'pstar'
    CHECK (creator_type IN ('channel', 'pstar'));

CREATE INDEX IF NOT EXISTS idx_creators_creator_type
  ON public.creators (creator_type);
