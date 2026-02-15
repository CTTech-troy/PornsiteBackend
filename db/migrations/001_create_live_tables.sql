-- 001_create_live_tables.sql

-- Lives table
CREATE TABLE IF NOT EXISTS lives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id text NOT NULL,
  status text NOT NULL DEFAULT 'created',
  viewers_count integer NOT NULL DEFAULT 0,
  total_likes bigint NOT NULL DEFAULT 0,
  total_gifts_amount numeric(12,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);

-- Live viewers
CREATE TABLE IF NOT EXISTS live_viewers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  live_id uuid REFERENCES lives(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  is_active boolean NOT NULL DEFAULT true
);

-- Live comments
CREATE TABLE IF NOT EXISTS live_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  live_id uuid REFERENCES lives(id) ON DELETE CASCADE,
  user_id text,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Live gifts
CREATE TABLE IF NOT EXISTS live_gifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  live_id uuid REFERENCES lives(id) ON DELETE CASCADE,
  sender_id text,
  gift_type text NOT NULL,
  amount numeric(12,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Wallets (simple host wallet record)
CREATE TABLE IF NOT EXISTS wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  balance numeric(14,2) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
