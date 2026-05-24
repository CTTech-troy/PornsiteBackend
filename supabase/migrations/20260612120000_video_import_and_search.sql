-- Video import jobs
CREATE TABLE IF NOT EXISTS video_import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id text,
  import_type text NOT NULL DEFAULT 'full',
  source_format text NOT NULL DEFAULT 'csv',
  status text NOT NULL DEFAULT 'pending',
  progress_percent numeric DEFAULT 0,
  rows_total integer DEFAULT 0,
  rows_processed integer DEFAULT 0,
  rows_ok integer DEFAULT 0,
  rows_skipped integer DEFAULT 0,
  rows_failed integer DEFAULT 0,
  staging_path text,
  checksum text,
  error_summary text,
  metadata jsonb DEFAULT '{}'::jsonb,
  rollback_snapshot_id text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS video_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid REFERENCES video_import_jobs(id) ON DELETE CASCADE,
  batch_no integer NOT NULL DEFAULT 0,
  rows_total integer DEFAULT 0,
  rows_ok integer DEFAULT 0,
  rows_skipped integer DEFAULT 0,
  cursor_offset bigint DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS video_import_errors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid REFERENCES video_import_jobs(id) ON DELETE CASCADE,
  row_number integer,
  raw_row jsonb,
  error_code text,
  message text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS video_import_deleted_urls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid REFERENCES video_import_jobs(id) ON DELETE CASCADE,
  url text NOT NULL,
  normalized_url text NOT NULL,
  processed_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_video_import_jobs_status ON video_import_jobs(status);
CREATE INDEX IF NOT EXISTS idx_video_import_jobs_created ON video_import_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_import_errors_job ON video_import_errors(job_id);

-- Catalog columns on tiktok_videos
ALTER TABLE tiktok_videos ADD COLUMN IF NOT EXISTS content_source text DEFAULT 'creator';
ALTER TABLE tiktok_videos ADD COLUMN IF NOT EXISTS import_job_id uuid;
ALTER TABLE tiktok_videos ADD COLUMN IF NOT EXISTS external_id text;
ALTER TABLE tiktok_videos ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE tiktok_videos ADD COLUMN IF NOT EXISTS import_hash text;
ALTER TABLE tiktok_videos ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE tiktok_videos ADD COLUMN IF NOT EXISTS is_indexed boolean DEFAULT false;
ALTER TABLE tiktok_videos ADD COLUMN IF NOT EXISTS meili_synced_at timestamptz;
ALTER TABLE tiktok_videos ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tiktok_videos_import_hash
  ON tiktok_videos(import_hash) WHERE import_hash IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tiktok_videos_content_source_created
  ON tiktok_videos(content_source, created_at DESC) WHERE deleted_at IS NULL;

-- Full-text search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE tiktok_videos ADD COLUMN IF NOT EXISTS search_document tsvector;

CREATE OR REPLACE FUNCTION tiktok_videos_search_document_update() RETURNS trigger AS $$
BEGIN
  NEW.search_document :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(array_to_string(NEW.tags, ' '), '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.main_orientation_category, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(NEW.creator_display_name, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(NEW.provider, '')), 'D');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tiktok_videos_search_document ON tiktok_videos;
CREATE TRIGGER trg_tiktok_videos_search_document
  BEFORE INSERT OR UPDATE OF title, tags, main_orientation_category, creator_display_name, provider
  ON tiktok_videos
  FOR EACH ROW EXECUTE FUNCTION tiktok_videos_search_document_update();

CREATE INDEX IF NOT EXISTS idx_tiktok_videos_search_document ON tiktok_videos USING GIN(search_document);
CREATE INDEX IF NOT EXISTS idx_tiktok_videos_title_trgm ON tiktok_videos USING GIN(title gin_trgm_ops);

-- Watch history
CREATE TABLE IF NOT EXISTS video_watch_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  video_id text NOT NULL,
  progress_seconds numeric DEFAULT 0,
  duration_seconds numeric DEFAULT 0,
  completed boolean DEFAULT false,
  last_watched_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, video_id)
);

CREATE INDEX IF NOT EXISTS idx_video_watch_history_user ON video_watch_history(user_id, last_watched_at DESC);

-- Search query log
CREATE TABLE IF NOT EXISTS video_search_queries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query text NOT NULL,
  result_count integer DEFAULT 0,
  user_id text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_video_search_queries_query ON video_search_queries(query, created_at DESC);

-- Search index queue
CREATE TABLE IF NOT EXISTS search_index_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id text NOT NULL,
  action text NOT NULL DEFAULT 'upsert',
  processed_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_search_index_queue_pending ON search_index_queue(created_at) WHERE processed_at IS NULL;

-- Platform activity events
CREATE TABLE IF NOT EXISTS platform_activity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  title text,
  message text,
  actor_id text,
  target_type text,
  target_id text,
  payload jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_activity_events_created ON platform_activity_events(created_at DESC);

-- Midroll platform settings (insert if platform_settings exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'platform_settings') THEN
    INSERT INTO platform_settings (key, value, label, section, type, default_value, public)
    VALUES
      ('midroll_enabled', 'false', 'Mid-roll Ads Enabled', 'Ads', 'toggle', 'false', true),
      ('midroll_cue_seconds', '120,300,600', 'Mid-roll Cue Seconds', 'Ads', 'text', '120,300,600', false),
      ('import_max_archive_mb', '2048', 'Max Import Archive MB', 'Uploads', 'number', '2048', false),
      ('import_batch_size', '500', 'Import Batch Size', 'Uploads', 'number', '500', false)
    ON CONFLICT (key) DO NOTHING;
  END IF;
EXCEPTION WHEN others THEN NULL;
END $$;
