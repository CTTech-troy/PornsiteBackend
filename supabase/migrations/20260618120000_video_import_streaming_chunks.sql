-- Streaming import chunk state. Chunks are durable queue jobs so failed chunks
-- can retry without replaying the whole archive.
ALTER TABLE video_import_batches ADD COLUMN IF NOT EXISTS status text DEFAULT 'pending';
ALTER TABLE video_import_batches ADD COLUMN IF NOT EXISTS chunk_path text;
ALTER TABLE video_import_batches ADD COLUMN IF NOT EXISTS row_start integer;
ALTER TABLE video_import_batches ADD COLUMN IF NOT EXISTS row_end integer;
ALTER TABLE video_import_batches ADD COLUMN IF NOT EXISTS rows_failed integer DEFAULT 0;
ALTER TABLE video_import_batches ADD COLUMN IF NOT EXISTS attempts integer DEFAULT 0;
ALTER TABLE video_import_batches ADD COLUMN IF NOT EXISTS error_summary text;
ALTER TABLE video_import_batches ADD COLUMN IF NOT EXISTS queued_at timestamptz;
ALTER TABLE video_import_batches ADD COLUMN IF NOT EXISTS started_at timestamptz;
ALTER TABLE video_import_batches ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE video_import_batches ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

DELETE FROM video_import_batches older
USING video_import_batches newer
WHERE older.ctid < newer.ctid
  AND older.job_id = newer.job_id
  AND older.batch_no = newer.batch_no;

CREATE UNIQUE INDEX IF NOT EXISTS idx_video_import_batches_job_batch
  ON video_import_batches(job_id, batch_no);

CREATE INDEX IF NOT EXISTS idx_video_import_batches_job_status
  ON video_import_batches(job_id, status, batch_no);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'platform_settings') THEN
    INSERT INTO platform_settings (key, value, label, section, type, default_value, public)
    VALUES
      ('import_batch_size', '500', 'Import Chunk Size', 'Uploads', 'number', '500', false)
    ON CONFLICT (key) DO NOTHING;
  END IF;
EXCEPTION WHEN others THEN NULL;
END $$;
