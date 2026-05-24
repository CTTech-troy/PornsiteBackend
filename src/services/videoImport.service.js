import { randomUUID, createHash } from 'crypto';
import { supabase, uploadFileToBucket } from '../config/supabase.js';
import { qstashClient } from '../config/qstash.js';
import { upstashRedis } from '../config/redis.js';
import { writePlatformActivityEvent } from './platformActivity.service.js';

const IMPORT_BUCKET = process.env.IMPORT_STAGING_BUCKET || 'imports-staging';
const REDIS_CURSOR_PREFIX = 'import:cursor:';

function isMissingTable(err) {
  return err?.code === '42P01' || err?.code === 'PGRST200' || /schema cache/i.test(String(err?.message || ''));
}

function getImportWorkflowUrl(path) {
  const base = String(process.env.BACKEND_PUBLIC_URL || process.env.API_BASE_URL || '').replace(/\/$/, '');
  if (!base) return null;
  return `${base}/api/internal/qstash/video-import${path}`;
}

export async function createImportJob({
  adminId,
  importType = 'full',
  sourceFormat = 'csv',
  metadata = {},
}) {
  if (!supabase) throw new Error('Database unavailable');
  const id = randomUUID();
  const stagingPath = `imports/${adminId || 'system'}/${id}/source.${sourceFormat === 'gz' ? 'gz' : sourceFormat === 'zip' ? 'zip' : 'csv'}`;

  const { data, error } = await supabase.from('video_import_jobs').insert({
    id,
    admin_id: adminId || null,
    import_type: importType,
    source_format: sourceFormat,
    status: 'pending',
    staging_path: stagingPath,
    metadata,
  }).select('*').single();

  if (error) throw error;
  return data;
}

export async function getImportJob(jobId) {
  if (!supabase) return null;
  const { data, error } = await supabase.from('video_import_jobs').select('*').eq('id', jobId).maybeSingle();
  if (error) throw error;
  return data;
}

export async function listImportJobs({ limit = 50, offset = 0, status = null } = {}) {
  if (!supabase) return [];
  let q = supabase.from('video_import_jobs').select('*').order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return data || [];
}

export async function updateImportJob(jobId, patch) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('video_import_jobs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', jobId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function createStagingUploadUrl(stagingPath, contentType) {
  if (!supabase) throw new Error('Storage unavailable');
  const { data, error } = await supabase.storage.from(IMPORT_BUCKET).createSignedUploadUrl(stagingPath);
  if (error) throw error;
  return { uploadUrl: data.signedUrl, path: stagingPath, contentType };
}

export async function downloadStagingFile(stagingPath, destPath) {
  if (!supabase) throw new Error('Storage unavailable');
  const { data, error } = await supabase.storage.from(IMPORT_BUCKET).download(stagingPath);
  if (error) throw error;
  const fs = await import('fs/promises');
  const buffer = Buffer.from(await data.arrayBuffer());
  await fs.writeFile(destPath, buffer);
  return destPath;
}

export async function setImportCursor(jobId, offset) {
  if (upstashRedis) {
    await upstashRedis.set(`${REDIS_CURSOR_PREFIX}${jobId}`, String(offset));
  }
  if (supabase) {
    await supabase.from('video_import_batches').insert({
      job_id: jobId,
      batch_no: Math.floor(offset / 500),
      cursor_offset: offset,
    }).catch(() => {});
  }
}

export async function getImportCursor(jobId) {
  if (upstashRedis) {
    const val = await upstashRedis.get(`${REDIS_CURSOR_PREFIX}${jobId}`);
    if (val != null) return Number(val) || 0;
  }
  if (!supabase) return 0;
  const { data } = await supabase
    .from('video_import_batches')
    .select('cursor_offset')
    .eq('job_id', jobId)
    .order('cursor_offset', { ascending: false })
    .limit(1)
    .maybeSingle();
  return Number(data?.cursor_offset) || 0;
}

export async function logImportError(jobId, rowNumber, rawRow, errorCode, message) {
  if (!supabase) return;
  await supabase.from('video_import_errors').insert({
    job_id: jobId,
    row_number: rowNumber,
    raw_row: rawRow || {},
    error_code: errorCode,
    message: String(message || '').slice(0, 2000),
  });
}

export async function enqueueImportStep(jobId, step, body = {}) {
  const url = getImportWorkflowUrl(`/${step}`);
  if (!qstashClient || !url) {
    return { queued: false, reason: 'QStash not configured' };
  }
  const result = await qstashClient.publishJSON({
    url,
    body: { jobId, ...body },
    retries: 3,
    headers: { 'Content-Type': 'application/json', 'X-Workflow-Source': 'video-import' },
  });
  return { queued: true, ...result };
}

export async function startImportJob(jobId) {
  const job = await getImportJob(jobId);
  if (!job) throw new Error('Import job not found');
  if (!['pending', 'failed', 'paused'].includes(job.status)) {
    throw new Error(`Cannot start job in status: ${job.status}`);
  }
  await updateImportJob(jobId, { status: 'queued', started_at: job.started_at || new Date().toISOString() });
  return enqueueImportStep(jobId, 'extract');
}

export async function finalizeImportJob(jobId, { success = true, errorSummary = null } = {}) {
  const job = await getImportJob(jobId);
  await updateImportJob(jobId, {
    status: success ? 'completed' : 'failed',
    progress_percent: success ? 100 : job?.progress_percent || 0,
    completed_at: new Date().toISOString(),
    error_summary: errorSummary,
  });
  await writePlatformActivityEvent({
    eventType: success ? 'import_completed' : 'import_failed',
    title: success ? 'Video import completed' : 'Video import failed',
    message: success
      ? `Import ${jobId} finished: ${job?.rows_ok || 0} videos imported`
      : `Import ${jobId} failed: ${errorSummary || 'Unknown error'}`,
    targetType: 'video_import_job',
    targetId: jobId,
    payload: { rowsOk: job?.rows_ok, rowsFailed: job?.rows_failed },
  });
}

export function computeImportHash(row) {
  const key = String(row.embed_url || row.embedUrl || row.external_id || row.externalId || row.title || '').trim().toLowerCase();
  return createHash('sha256').update(key).digest('hex').slice(0, 64);
}

export async function getImportAnalytics() {
  if (!supabase) return { totalJobs: 0, completed: 0, failed: 0, rowsImported: 0 };
  const { data: jobs } = await supabase.from('video_import_jobs').select('status, rows_ok, rows_failed, created_at').order('created_at', { ascending: false }).limit(500);
  const list = jobs || [];
  return {
    totalJobs: list.length,
    completed: list.filter((j) => j.status === 'completed').length,
    failed: list.filter((j) => j.status === 'failed').length,
    rowsImported: list.reduce((s, j) => s + Number(j.rows_ok || 0), 0),
    recent: list.slice(0, 10),
  };
}
