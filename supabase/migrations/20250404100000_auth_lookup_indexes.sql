-- Optional: faster admin / list queries on verification state (Firebase UID is already PK on users.id)
CREATE INDEX IF NOT EXISTS idx_users_verified ON public.users (verified);
