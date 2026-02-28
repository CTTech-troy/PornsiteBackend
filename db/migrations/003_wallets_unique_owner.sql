-- 003_wallets_unique_owner.sql
-- Required for upsert(..., { onConflict: 'owner_id' }) in endLive
ALTER TABLE wallets ADD CONSTRAINT wallets_owner_id_key UNIQUE (owner_id);
