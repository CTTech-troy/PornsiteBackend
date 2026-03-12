-- 003_one_active_live_per_host.sql
-- Ensure only one active (live or paused) stream per host at the database level.

CREATE UNIQUE INDEX IF NOT EXISTS idx_lives_one_active_per_host
  ON lives (host_id)
  WHERE status IN ('live', 'paused');
