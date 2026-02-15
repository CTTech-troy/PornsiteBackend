-- 002_create_transactions_creators.sql

-- Creators table (basic profile)
CREATE TABLE IF NOT EXISTS creators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text UNIQUE NOT NULL,
  display_name text,
  bio text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);

-- Transactions ledger for wallets
CREATE TABLE IF NOT EXISTS transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  type text NOT NULL,
  amount numeric(14,2) NOT NULL,
  balance_after numeric(14,2) NOT NULL,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
