-- Atomic wallet debit: checks balance and deducts in a single transaction.
-- Raises an exception if insufficient funds. Returns the new balance.
CREATE OR REPLACE FUNCTION debit_wallet(p_owner_id TEXT, p_amount NUMERIC)
RETURNS NUMERIC
LANGUAGE plpgsql
AS $$
DECLARE
  v_balance NUMERIC;
BEGIN
  -- Lock the row for the duration of this transaction
  SELECT balance INTO v_balance
    FROM wallets
   WHERE owner_id = p_owner_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found for owner %', p_owner_id;
  END IF;

  IF v_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance: have %, need %', v_balance, p_amount;
  END IF;

  UPDATE wallets
     SET balance    = balance - p_amount,
         updated_at = NOW()
   WHERE owner_id = p_owner_id;

  RETURN v_balance - p_amount;
END;
$$;

-- Atomic wallet credit: creates wallet if missing, then adds funds atomically.
-- Returns the new balance.
CREATE OR REPLACE FUNCTION credit_wallet(p_owner_id TEXT, p_amount NUMERIC)
RETURNS NUMERIC
LANGUAGE plpgsql
AS $$
DECLARE
  v_balance NUMERIC;
BEGIN
  -- Attempt to insert; do nothing if it already exists
  INSERT INTO wallets (owner_id, balance)
  VALUES (p_owner_id, 0)
  ON CONFLICT (owner_id) DO NOTHING;

  -- Lock the row and update atomically
  UPDATE wallets
     SET balance    = balance + p_amount,
         updated_at = NOW()
   WHERE owner_id = p_owner_id
  RETURNING balance INTO v_balance;

  RETURN v_balance;
END;
$$;
