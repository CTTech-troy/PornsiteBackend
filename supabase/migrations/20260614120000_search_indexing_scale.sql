-- Production-scale Meilisearch indexing: resumable chunks, retries, pause/resume,
-- dead letters, and queue locks for large imports/reindexes.

ALTER TABLE IF EXISTS public.search_index_queue
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by text,
  ADD COLUMN IF NOT EXISTS dead_letter_at timestamptz,
  ADD COLUMN IF NOT EXISTS batch_id uuid,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_search_index_queue_ready
  ON public.search_index_queue(next_attempt_at, created_at)
  WHERE processed_at IS NULL AND dead_letter_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_search_index_queue_dead_letter
  ON public.search_index_queue(dead_letter_at DESC)
  WHERE dead_letter_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.search_index_control (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  paused boolean NOT NULL DEFAULT false,
  paused_reason text,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.search_index_control (id, paused)
VALUES (1, false)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.search_index_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES public.search_sync_runs(id) ON DELETE SET NULL,
  target text NOT NULL,
  index_name text NOT NULL,
  table_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  batch_no integer NOT NULL DEFAULT 0,
  cursor_offset bigint NOT NULL DEFAULT 0,
  batch_size integer NOT NULL DEFAULT 1000,
  total_estimated bigint NOT NULL DEFAULT 0,
  processed_count integer NOT NULL DEFAULT 0,
  indexed_count integer NOT NULL DEFAULT 0,
  deleted_count integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  next_attempt_at timestamptz,
  locked_at timestamptz,
  locked_by text,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, target, batch_no)
);

CREATE INDEX IF NOT EXISTS idx_search_index_batches_status
  ON public.search_index_batches(status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS idx_search_index_batches_run
  ON public.search_index_batches(run_id, batch_no);

CREATE INDEX IF NOT EXISTS idx_search_index_batches_locked
  ON public.search_index_batches(locked_at)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS public.search_index_dead_letters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  source_id text,
  run_id uuid,
  batch_id uuid,
  target text,
  action text,
  attempts integer NOT NULL DEFAULT 0,
  error_message text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_search_index_dead_letters_unresolved
  ON public.search_index_dead_letters(created_at DESC)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_search_sync_runs_status
  ON public.search_sync_runs(status, started_at DESC);
