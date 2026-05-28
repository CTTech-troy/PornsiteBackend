-- Denormalized import progress columns for recovery and admin queries.
ALTER TABLE video_import_jobs ADD COLUMN IF NOT EXISTS current_chunk integer DEFAULT 0;
ALTER TABLE video_import_jobs ADD COLUMN IF NOT EXISTS total_chunks integer DEFAULT 0;
ALTER TABLE video_import_jobs ADD COLUMN IF NOT EXISTS import_status text;

-- Backfill from metadata where available.
UPDATE video_import_jobs
SET
  current_chunk = COALESCE(current_chunk, NULLIF((metadata->'importProgress'->>'currentChunk')::integer, 0)),
  total_chunks = COALESCE(NULLIF(total_chunks, 0), NULLIF((metadata->'importProgress'->>'totalChunks')::integer, 0)),
  import_status = COALESCE(import_status, metadata->'importProgress'->>'importStatus', status)
WHERE metadata ? 'importProgress';
