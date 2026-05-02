-- Full schema upgrade for creator_payout_requests
-- Adds NGN amounts, bank codes, references, email, and processed_by

ALTER TABLE IF EXISTS creator_payout_requests
  ADD COLUMN IF NOT EXISTS amount_ngn    numeric(14,2),
  ADD COLUMN IF NOT EXISTS bank_code     text,
  ADD COLUMN IF NOT EXISTS reference_id  text,
  ADD COLUMN IF NOT EXISTS creator_email text,
  ADD COLUMN IF NOT EXISTS processed_by  text;

CREATE INDEX IF NOT EXISTS creator_payout_requests_status_idx
  ON creator_payout_requests(status);

CREATE INDEX IF NOT EXISTS creator_payout_requests_creator_idx
  ON creator_payout_requests(creator_id);

CREATE UNIQUE INDEX IF NOT EXISTS creator_payout_requests_reference_idx
  ON creator_payout_requests(reference_id)
  WHERE reference_id IS NOT NULL;
