-- Creator payout Paystack processing + Finance Hub payout logs.

ALTER TABLE IF EXISTS creator_payout_requests
  DROP CONSTRAINT IF EXISTS creator_payout_requests_status_check;

ALTER TABLE IF EXISTS creator_payout_requests
  ADD CONSTRAINT creator_payout_requests_status_check
  CHECK (status IN ('pending', 'processing', 'paid', 'completed', 'failed', 'rejected'));

ALTER TABLE IF EXISTS creator_payout_requests
  ADD COLUMN IF NOT EXISTS account_name text,
  ADD COLUMN IF NOT EXISTS paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS payment_provider text,
  ADD COLUMN IF NOT EXISTS paystack_recipient_code text,
  ADD COLUMN IF NOT EXISTS paystack_transfer_code text,
  ADD COLUMN IF NOT EXISTS paystack_transaction_reference text,
  ADD COLUMN IF NOT EXISTS failure_reason text,
  ADD COLUMN IF NOT EXISTS payment_metadata jsonb DEFAULT '{}';

CREATE INDEX IF NOT EXISTS creator_payout_requests_paid_at_idx
  ON creator_payout_requests(paid_at);

CREATE INDEX IF NOT EXISTS creator_payout_requests_paystack_reference_idx
  ON creator_payout_requests(paystack_transaction_reference)
  WHERE paystack_transaction_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS finance_payout_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_request_id uuid REFERENCES creator_payout_requests(id) ON DELETE SET NULL,
  creator_id text NOT NULL,
  creator_name text,
  amount_usd numeric(12,2) NOT NULL DEFAULT 0,
  amount_ngn numeric(14,2),
  transaction_reference text,
  payout_status text NOT NULL,
  payment_date timestamptz,
  provider text DEFAULT 'paystack',
  error_message text,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS finance_payout_logs_status_idx
  ON finance_payout_logs(payout_status);

CREATE INDEX IF NOT EXISTS finance_payout_logs_creator_idx
  ON finance_payout_logs(creator_id);

CREATE INDEX IF NOT EXISTS finance_payout_logs_created_at_idx
  ON finance_payout_logs(created_at DESC);
