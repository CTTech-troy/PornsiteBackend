-- Prevent duplicate active creator applications per user.
-- Only one open application (pending/info_requested) is allowed at a time.

CREATE UNIQUE INDEX IF NOT EXISTS uq_creator_applications_one_open_per_user
  ON public.creator_applications (user_id)
  WHERE status IN ('pending', 'info_requested');

