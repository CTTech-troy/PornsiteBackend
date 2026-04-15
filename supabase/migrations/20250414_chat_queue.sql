-- 20250414_chat_queue.sql
-- Random video chat matching queue and rooms

-- -------------------------------------------------------------------
-- Tables
-- -------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS chat_queue (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     text        NOT NULL UNIQUE,
  gender      text        NOT NULL DEFAULT 'any',   -- 'male' | 'female' | 'any'
  socket_id   text        NOT NULL,
  joined_at   timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_queue_gender    ON chat_queue (gender);
CREATE INDEX IF NOT EXISTS idx_chat_queue_joined_at ON chat_queue (joined_at);

CREATE TABLE IF NOT EXISTS chat_rooms (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_a_id   text        NOT NULL,
  user_b_id   text        NOT NULL,
  created_at  timestamptz DEFAULT now() NOT NULL,
  ended_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_chat_rooms_user_a ON chat_rooms (user_a_id);
CREATE INDEX IF NOT EXISTS idx_chat_rooms_user_b ON chat_rooms (user_b_id);

-- -------------------------------------------------------------------
-- RPC: enqueue_user
-- Upserts a user into the queue (replaces stale socket_id on reconnect)
-- -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enqueue_user(
  p_user_id   text,
  p_gender    text,
  p_socket_id text
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO chat_queue (user_id, gender, socket_id, joined_at)
  VALUES (p_user_id, p_gender, p_socket_id, now())
  ON CONFLICT (user_id) DO UPDATE
    SET gender    = EXCLUDED.gender,
        socket_id = EXCLUDED.socket_id,
        joined_at = now();
END;
$$;

-- -------------------------------------------------------------------
-- RPC: dequeue_and_match
-- Atomically find the oldest compatible partner and create a room.
-- Returns (room_id uuid, peer_user_id text, peer_socket_id text).
-- Returns NULL row if no partner is available.
-- -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dequeue_and_match(
  p_user_id text,
  p_gender  text
)
RETURNS TABLE(room_id uuid, peer_user_id text, peer_socket_id text)
LANGUAGE plpgsql
AS $$
DECLARE
  v_peer         chat_queue%ROWTYPE;
  v_room_id      uuid;
BEGIN
  -- Lock and fetch the oldest compatible partner (not the caller themselves)
  SELECT *
    INTO v_peer
    FROM chat_queue
   WHERE user_id <> p_user_id
     AND (p_gender = 'any' OR gender = 'any' OR gender = p_gender)
   ORDER BY joined_at ASC
   LIMIT 1
   FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    -- No partner yet — caller stays in the queue
    RETURN;
  END IF;

  -- Remove both users from the queue
  DELETE FROM chat_queue WHERE user_id IN (p_user_id, v_peer.user_id);

  -- Create the room
  INSERT INTO chat_rooms (user_a_id, user_b_id)
  VALUES (p_user_id, v_peer.user_id)
  RETURNING id INTO v_room_id;

  RETURN QUERY SELECT v_room_id, v_peer.user_id, v_peer.socket_id;
END;
$$;

-- -------------------------------------------------------------------
-- RPC: end_chat_room
-- Marks a room as ended (idempotent).
-- -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION end_chat_room(p_room_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE chat_rooms
     SET ended_at = now()
   WHERE id = p_room_id
     AND ended_at IS NULL;
END;
$$;

-- -------------------------------------------------------------------
-- RPC: cleanup_stale_queue
-- Remove queue entries older than p_seconds_old seconds.
-- Call periodically (e.g. every 60 s) to evict ghost entries.
-- -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cleanup_stale_queue(p_seconds_old int DEFAULT 30)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted int;
BEGIN
  DELETE FROM chat_queue
   WHERE joined_at < now() - (p_seconds_old || ' seconds')::interval;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;
