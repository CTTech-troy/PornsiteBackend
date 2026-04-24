-- =============================================================================
-- Tokens system  (coin_balance is the single balance column)
-- =============================================================================

-- 1. Ensure coin_balance exists (the primary balance column)
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS coin_balance numeric NOT NULL DEFAULT 0
    CHECK (coin_balance >= 0);

-- 2. Token transactions ledger
CREATE TABLE IF NOT EXISTS public.token_transactions (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          text        NOT NULL,
  type             text        NOT NULL
                     CHECK (type IN ('purchase','gift_sent','gift_received','refund','adjustment')),
  amount           numeric     NOT NULL,
  payment_amount   numeric,
  payment_currency text        DEFAULT 'USD',
  status           text        NOT NULL DEFAULT 'completed'
                     CHECK (status IN ('pending','completed','failed')),
  reference        text,
  metadata         jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS token_transactions_user_id_idx ON public.token_transactions (user_id, created_at DESC);

-- 3. Extend live_gifts with token columns
ALTER TABLE public.live_gifts
  ADD COLUMN IF NOT EXISTS token_price          numeric,
  ADD COLUMN IF NOT EXISTS gift_emoji           text,
  ADD COLUMN IF NOT EXISTS gift_name            text,
  ADD COLUMN IF NOT EXISTS sender_name          text,
  ADD COLUMN IF NOT EXISTS sender_balance_after numeric;

-- 4. RPC: atomically add coins (called after successful payment webhook)
CREATE OR REPLACE FUNCTION public.add_coins(p_user_id text, p_amount numeric)
RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_new_balance numeric;
BEGIN
  UPDATE public.users
    SET coin_balance = COALESCE(coin_balance, 0) + p_amount
  WHERE id = p_user_id
  RETURNING coin_balance INTO v_new_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_not_found' USING HINT = 'user_id does not exist';
  END IF;

  RETURN v_new_balance;
END;
$$;

-- 5. RPC: atomically spend coins and record the gift in one transaction
CREATE OR REPLACE FUNCTION public.spend_coins_and_gift(
  p_user_id      text,
  p_creator_id   text,
  p_stream_id    text,
  p_gift_id      text,
  p_gift_name    text,
  p_gift_emoji   text,
  p_token_price  numeric,
  p_sender_name  text DEFAULT NULL
)
RETURNS TABLE(new_balance numeric, gift_row_id uuid)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_balance     numeric;
  v_new_balance numeric;
  v_gift_id     uuid;
BEGIN
  -- Lock user row and verify sufficient balance
  SELECT coin_balance INTO v_balance
    FROM public.users
   WHERE id = p_user_id
     FOR UPDATE;

  IF v_balance IS NULL OR v_balance < p_token_price THEN
    RAISE EXCEPTION 'insufficient_tokens'
      USING HINT = 'token_balance', DETAIL = format('balance=%s required=%s', v_balance, p_token_price);
  END IF;

  -- Deduct coins
  UPDATE public.users
    SET coin_balance = coin_balance - p_token_price
  WHERE id = p_user_id
  RETURNING coin_balance INTO v_new_balance;

  -- Persist the gift row
  INSERT INTO public.live_gifts (
    live_id, sender_id,
    gift_type, gift_name, gift_emoji, sender_name,
    amount, token_price, sender_balance_after
  ) VALUES (
    p_stream_id::uuid, p_user_id::uuid,
    p_gift_id, p_gift_name, p_gift_emoji, p_sender_name,
    p_token_price, p_token_price, v_new_balance
  )
  RETURNING id INTO v_gift_id;

  -- Ledger: gift_sent for sender
  INSERT INTO public.token_transactions (user_id, type, amount, metadata)
  VALUES (
    p_user_id, 'gift_sent', p_token_price,
    jsonb_build_object(
      'gift_id',   p_gift_id,
      'stream_id', p_stream_id,
      'creator_id', p_creator_id
    )
  );

  -- Ledger: gift_received for creator
  INSERT INTO public.token_transactions (user_id, type, amount, metadata)
  VALUES (
    p_creator_id, 'gift_received', p_token_price,
    jsonb_build_object(
      'gift_id',   p_gift_id,
      'stream_id', p_stream_id,
      'sender_id', p_user_id
    )
  );

  RETURN QUERY SELECT v_new_balance, v_gift_id;
END;
$$;

-- 6. RLS for token_transactions (backend uses service_role, bypasses RLS)
ALTER TABLE public.token_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all_token_transactions" ON public.token_transactions;
CREATE POLICY "service_role_all_token_transactions"
  ON public.token_transactions FOR ALL
  TO service_role USING (true);

-- 7. Grant RPC execution to service_role
GRANT EXECUTE ON FUNCTION public.add_coins TO service_role;
GRANT EXECUTE ON FUNCTION public.spend_coins_and_gift TO service_role;
