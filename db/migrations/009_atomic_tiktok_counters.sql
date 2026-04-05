-- Migration 009: Atomic counters for TikTok videos
-- Fixes BUG-04 race conditions for likes, views, and comments.

CREATE OR REPLACE FUNCTION adjust_tiktok_stat(p_video_id TEXT, p_stat_name TEXT, p_delta INT)
RETURNS INT AS $$
DECLARE
  new_count INT;
BEGIN
  -- Prevent SQL injection by validating the column name
  IF p_stat_name NOT IN ('likes_count', 'views_count', 'comments_count', 'shares_count') THEN
    RAISE EXCEPTION 'Invalid stat name "%"', p_stat_name;
  END IF;

  -- Use EXECUTE to build the query dynamically but safely with parametrised inputs
  EXECUTE format('
    UPDATE tiktok_videos 
    SET %I = GREATEST(COALESCE(%I, 0) + $1, 0) 
    WHERE video_id = $2
    RETURNING %I
  ', p_stat_name, p_stat_name, p_stat_name)
  INTO new_count
  USING p_delta, p_video_id;

  RETURN new_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
