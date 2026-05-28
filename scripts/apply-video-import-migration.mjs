/**
 * Checks and applies the video import SQL needed by the streaming importer.
 *
 * To auto-apply, backend/.env must contain DATABASE_URL, SUPABASE_DB_URL,
 * SUPABASE_DATABASE_URL, or SUPABASE_DB_PASSWORD plus SUPABASE_URL.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
dotenv.config({ path: path.join(rootDir, '.env'), quiet: true });

const BASE_FILE = path.join(rootDir, 'supabase', 'migrations', '20260612120000_video_import_and_search.sql');
const STREAMING_FILE = path.join(rootDir, 'supabase', 'migrations', '20260618120000_video_import_streaming_chunks.sql');
const ENTERPRISE_FILE = path.join(rootDir, 'supabase', 'migrations', '20260627120000_enterprise_r2_csv_import.sql');
const IMPORT_BUCKET = process.env.IMPORT_STAGING_BUCKET || 'imports-staging';

const TABLE_CHECKS = [
  {
    name: 'upload_sessions',
    select: 'id,status,original_filename,content_type,size_bytes,r2_bucket,r2_key,r2_upload_id,part_size_bytes,multipart_parts,expires_at,created_at,updated_at',
  },
  {
    name: 'import_jobs',
    select: 'id,upload_session_id,status,total_rows,processed_rows,inserted_rows,updated_rows,duplicate_rows,failed_rows,checkpoint_row_number,metadata,created_at,updated_at',
  },
  {
    name: 'failed_rows',
    select: 'id,import_job_id,row_number,raw_row,cleaned_row,error_code,error_message,created_at',
  },
  {
    name: 'videos',
    select: 'id,video_url,title,duration,thumbnail_url,tags,actors,views,category,quality,studio,publish_date,metadata,video_fingerprint,import_job_id,source_row_number,created_at,updated_at',
  },
  {
    name: 'video_import_jobs',
    select: 'id,status,metadata,rows_total,rows_processed,rows_ok,rows_failed,progress_percent,staging_path',
  },
  {
    name: 'video_import_batches',
    select: 'id,job_id,batch_no,status,chunk_path,row_start,row_end,rows_total,rows_ok,rows_failed,attempts,error_summary,queued_at,started_at,completed_at,updated_at',
  },
  {
    name: 'video_import_errors',
    select: 'id,job_id,row_number,raw_row,error_code,message,created_at',
  },
  {
    name: 'video_import_deleted_urls',
    select: 'id,job_id,url,normalized_url,processed_at,created_at',
  },
  {
    name: 'tiktok_videos',
    select: 'video_id,content_source,import_job_id,external_id,provider,import_hash,deleted_at,is_indexed,meili_synced_at,metadata,search_document',
  },
];

function maskDbUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '[configured]';
  }
}

function resolveDatabaseUrl() {
  const direct =
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DB_URL ||
    process.env.SUPABASE_DATABASE_URL ||
    '';
  if (direct.trim()) return direct.trim();

  const password = (process.env.SUPABASE_DB_PASSWORD || '').trim();
  const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
  if (!password || !supabaseUrl) return '';

  const ref = new URL(supabaseUrl).hostname.split('.')[0];
  return `postgresql://postgres:${encodeURIComponent(password)}@db.${ref}.supabase.co:5432/postgres`;
}

function createSupabaseClient() {
  const url = (process.env.SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) return null;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function checkTable(supabase, check) {
  const { error } = await supabase.from(check.name).select(check.select).limit(1);
  return {
    name: check.name,
    ok: !error,
    code: error?.code || null,
    message: error?.message || null,
  };
}

async function checkStorageBucket(supabase) {
  const { error } = await supabase.storage.getBucket(IMPORT_BUCKET);
  if (!error) return { name: IMPORT_BUCKET, ok: true };

  await supabase.storage.createBucket(IMPORT_BUCKET, { public: false }).catch(() => {});
  await supabase.storage.updateBucket(IMPORT_BUCKET, { public: false }).catch(() => {});

  const { error: retryError } = await supabase.storage.getBucket(IMPORT_BUCKET);
  return {
    name: IMPORT_BUCKET,
    ok: !retryError,
    code: retryError?.statusCode || retryError?.code || null,
    message: retryError?.message || null,
  };
}

async function scanViaApi() {
  const supabase = createSupabaseClient();
  if (!supabase) {
    return {
      configured: false,
      checks: [],
      bucket: { name: IMPORT_BUCKET, ok: false, message: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing' },
    };
  }

  const checks = [];
  for (const check of TABLE_CHECKS) {
    checks.push(await checkTable(supabase, check));
  }
  const bucket = await checkStorageBucket(supabase);
  return { configured: true, checks, bucket };
}

async function applyViaPg(connectionString) {
  const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const baseSql = fs.readFileSync(BASE_FILE, 'utf8');
    const streamingSql = fs.readFileSync(STREAMING_FILE, 'utf8');
    const enterpriseSql = fs.readFileSync(ENTERPRISE_FILE, 'utf8');
    await client.query('begin');
    await client.query(baseSql);
    await client.query(streamingSql);
    await client.query(enterpriseSql);
    await client.query('commit');
    await client.query("notify pgrst, 'reload schema';");
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

function printScan(scan) {
  if (!scan.configured) {
    console.log('[video-import] Supabase REST credentials are not configured.');
    return;
  }
  for (const check of scan.checks) {
    const status = check.ok ? 'ok' : 'missing';
    console.log(`[video-import] table ${check.name}: ${status}${check.message ? ` (${check.message})` : ''}`);
  }
  console.log(`[video-import] storage bucket ${scan.bucket.name}: ${scan.bucket.ok ? 'ok' : 'missing'}`);
}

async function main() {
  console.log('[video-import] Scanning import schema...');
  let scan = await scanViaApi();
  printScan(scan);

  const missing = scan.checks.filter((check) => !check.ok);
  if (!missing.length && scan.bucket.ok) {
    console.log('[video-import] Import schema is ready.');
    return;
  }

  const dbUrl = resolveDatabaseUrl();
  if (!dbUrl) {
    console.error('');
    console.error('[video-import] Cannot auto-apply SQL: no Postgres connection was found.');
    console.error('Add DATABASE_URL or SUPABASE_DB_PASSWORD to backend/.env, then run:');
    console.error('  npm run migrate:video-import');
    console.error('');
    console.error('Or paste these files into Supabase Dashboard > SQL Editor in this order:');
    console.error(`  ${BASE_FILE}`);
    console.error(`  ${STREAMING_FILE}`);
    console.error(`  ${ENTERPRISE_FILE}`);
    process.exit(1);
  }

  console.log(`[video-import] Applying import migrations via ${maskDbUrl(dbUrl)}...`);
  await applyViaPg(dbUrl);
  console.log('[video-import] SQL applied. Waiting for PostgREST schema reload...');
  await new Promise((resolve) => setTimeout(resolve, 1500));

  scan = await scanViaApi();
  printScan(scan);
  const stillMissing = scan.checks.filter((check) => !check.ok);
  if (stillMissing.length || !scan.bucket.ok) {
    console.error('[video-import] Migration ran, but schema is still not ready.');
    process.exit(1);
  }
  console.log('[video-import] Import schema is ready.');
}

main().catch((err) => {
  console.error('[video-import] Failed:', err?.message || err);
  process.exit(1);
});
