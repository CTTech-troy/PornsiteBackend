-- Add creator_type column to creators table
-- Distinguishes channels from individual pstars

ALTER TABLE public.creators
  ADD COLUMN IF NOT EXISTS creator_type TEXT NOT NULL DEFAULT 'pstar'
    CHECK (creator_type IN ('channel', 'pstar'));

CREATE INDEX IF NOT EXISTS idx_creators_creator_type
  ON public.creators (creator_type);