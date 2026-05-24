-- Meilisearch multi-index queue and analytics support.

ALTER TABLE IF EXISTS public.search_index_queue
  ADD COLUMN IF NOT EXISTS object_type text NOT NULL DEFAULT 'video',
  ADD COLUMN IF NOT EXISTS object_id text,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS error_message text,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;

UPDATE public.search_index_queue
   SET object_id = coalesce(object_id, video_id),
       object_type = coalesce(object_type, 'video')
 WHERE object_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_search_index_queue_object
  ON public.search_index_queue(object_type, object_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_search_index_queue_failed
  ON public.search_index_queue(created_at DESC)
  WHERE processed_at IS NULL AND error_message IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.search_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'running',
  action text NOT NULL DEFAULT 'reindex',
  started_by text,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_search_sync_runs_started
  ON public.search_sync_runs(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_video_search_queries_created
  ON public.video_search_queries(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tiktok_videos_meili_sync
  ON public.tiktok_videos(meili_synced_at, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION public.enqueue_meili_search_document()
RETURNS trigger AS $$
DECLARE
  v_type text := TG_ARGV[0];
  v_action text := 'upsert';
  v_object_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_action := 'delete';
  END IF;

  IF v_type = 'video' THEN
    v_object_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.video_id::text ELSE NEW.video_id::text END;
    IF TG_OP <> 'DELETE'
      AND (
        NEW.deleted_at IS NOT NULL
        OR (coalesce(NEW.is_live, false) IS NOT TRUE AND coalesce(NEW.status, 'published') <> 'published')
      )
    THEN
      v_action := 'delete';
    END IF;
  ELSIF v_type = 'creator' THEN
    v_object_id := CASE WHEN TG_OP = 'DELETE' THEN coalesce(OLD.user_id, OLD.id::text) ELSE coalesce(NEW.user_id, NEW.id::text) END;
  ELSIF v_type = 'user' THEN
    v_object_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id::text ELSE NEW.id::text END;
  ELSIF v_type = 'live_stream' THEN
    v_object_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id::text ELSE NEW.id::text END;
  END IF;

  IF v_object_id IS NOT NULL THEN
    INSERT INTO public.search_index_queue(object_type, object_id, video_id, action)
    VALUES (v_type, v_object_id, v_object_id, v_action);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF to_regclass('public.tiktok_videos') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_meili_tiktok_videos_queue ON public.tiktok_videos';
    EXECUTE 'CREATE TRIGGER trg_meili_tiktok_videos_queue AFTER INSERT OR UPDATE OR DELETE ON public.tiktok_videos FOR EACH ROW EXECUTE FUNCTION public.enqueue_meili_search_document(''video'')';
  END IF;

  IF to_regclass('public.creators') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_meili_creators_queue ON public.creators';
    EXECUTE 'CREATE TRIGGER trg_meili_creators_queue AFTER INSERT OR UPDATE OR DELETE ON public.creators FOR EACH ROW EXECUTE FUNCTION public.enqueue_meili_search_document(''creator'')';
  END IF;

  IF to_regclass('public.users') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_meili_users_queue ON public.users';
    EXECUTE 'CREATE TRIGGER trg_meili_users_queue AFTER INSERT OR UPDATE OR DELETE ON public.users FOR EACH ROW EXECUTE FUNCTION public.enqueue_meili_search_document(''user'')';
  END IF;

  IF to_regclass('public.lives') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_meili_lives_queue ON public.lives';
    EXECUTE 'CREATE TRIGGER trg_meili_lives_queue AFTER INSERT OR UPDATE OR DELETE ON public.lives FOR EACH ROW EXECUTE FUNCTION public.enqueue_meili_search_document(''live_stream'')';
  END IF;
END $$;
