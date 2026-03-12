-- 004_create_live_streams.sql
-- Optional live_streams table for stream lifecycle tracking.
-- user_id is text to support Firebase UID; one active stream per user enforced by unique index.
-- Application may use this table for analytics or migrate from lives table later.

CREATE TABLE IF NOT EXISTS live_streams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  title text,
  status text NOT NULL DEFAULT 'active',
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);

-- Only one active stream per user
CREATE UNIQUE INDEX IF NOT EXISTS idx_live_streams_one_active_per_user
  ON live_streams (user_id)
  WHERE status = 'active';

COMMENT ON TABLE live_streams IS 'Stream sessions; one active per user. App may use lives table for real-time data.';
