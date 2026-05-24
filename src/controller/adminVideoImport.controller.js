import multer from 'multer';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import {
  createImportJob,
  listImportJobs,
  getImportJob,
  startImportJob,
  createStagingUploadUrl,
  getImportAnalytics,
  updateImportJob,
} from '../services/videoImport.service.js';
import { subscribePlatformActivityEvents } from '../services/platformActivity.service.js';
import { supabase, uploadFileToBucket } from '../config/supabase.js';

const IMPORT_BUCKET = process.env.IMPORT_STAGING_BUCKET || 'imports-staging';

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: Number(process.env.IMPORT_MAX_ARCHIVE_MB || 2048) * 1024 * 1024 },
});

export async function createJob(req, res) {
  try {
    const importType = String(req.body?.importType || 'full');
    const sourceFormat = String(req.body?.sourceFormat || 'csv');
    const job = await createImportJob({
      adminId: req.admin?.id || req.admin?.email,
      importType,
      sourceFormat,
      metadata: req.body?.metadata || {},
    });
    const contentType = sourceFormat === 'zip'
      ? 'application/zip'
      : sourceFormat === 'gz'
        ? 'application/gzip'
        : 'text/csv';
    const signed = await createStagingUploadUrl(job.staging_path, contentType);
    return res.json({ success: true, job, upload: signed });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed to create job' });
  }
}

export function uploadImportFile(req, res) {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message });
    try {
      const importType = String(req.body?.importType || 'full');
      let sourceFormat = String(req.body?.sourceFormat || '').toLowerCase();
      const file = req.file;
      if (!file) return res.status(400).json({ success: false, message: 'file required' });

      const ext = path.extname(file.originalname).toLowerCase();
      if (!sourceFormat) {
        if (ext === '.zip') sourceFormat = 'zip';
        else if (ext === '.gz') sourceFormat = 'gz';
        else sourceFormat = 'csv';
      }

      const job = await createImportJob({
        adminId: req.admin?.id || req.admin?.email,
        importType,
        sourceFormat,
      });

      const buffer = await fs.promises.readFile(file.path);
      await uploadFileToBucket(IMPORT_BUCKET, job.staging_path, { buffer }, file.mimetype || 'application/octet-stream');
      await fs.promises.unlink(file.path).catch(() => {});

      await updateImportJob(job.id, { status: 'uploaded', checksum: randomUUID() });
      const started = await startImportJob(job.id);
      return res.json({ success: true, job, queued: started?.queued !== false });
    } catch (e) {
      return res.status(500).json({ success: false, message: e?.message || 'Upload failed' });
    }
  });
}

export async function listJobs(req, res) {
  try {
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const status = req.query.status || null;
    const jobs = await listImportJobs({ limit, offset, status });
    return res.json({ success: true, data: jobs });
  } catch (err) {
    return res.status(500).json({ success: false, data: [], message: err?.message });
  }
}

export async function getJob(req, res) {
  try {
    const job = await getImportJob(req.params.jobId);
    if (!job) return res.status(404).json({ success: false, message: 'Not found' });
    let errors = [];
    if (supabase) {
      const { data } = await supabase
        .from('video_import_errors')
        .select('*')
        .eq('job_id', job.id)
        .order('created_at', { ascending: false })
        .limit(20);
      errors = data || [];
    }
    return res.json({ success: true, job, errors });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message });
  }
}

export async function startJob(req, res) {
  try {
    const result = await startImportJob(req.params.jobId);
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(400).json({ success: false, message: err?.message });
  }
}

export async function retryJob(req, res) {
  try {
    await updateImportJob(req.params.jobId, { status: 'queued', error_summary: null });
    const result = await startImportJob(req.params.jobId);
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(400).json({ success: false, message: err?.message });
  }
}

export async function rollbackJob(req, res) {
  try {
    const { enqueueImportStep } = await import('../services/videoImport.service.js');
    await enqueueImportStep(req.params.jobId, 'rollback');
    return res.json({ success: true, queued: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message });
  }
}

export async function getJobErrors(req, res) {
  try {
    if (!supabase) return res.json({ success: true, data: [] });
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const { data, error } = await supabase
      .from('video_import_errors')
      .select('*')
      .eq('job_id', req.params.jobId)
      .order('row_number', { ascending: true })
      .range(offset, offset + limit - 1);
    if (error) throw error;
    return res.json({ success: true, data: data || [] });
  } catch (err) {
    return res.status(500).json({ success: false, data: [] });
  }
}

export async function getAnalytics(req, res) {
  try {
    const analytics = await getImportAnalytics();
    return res.json({ success: true, analytics });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message });
  }
}

export function importEventsStream(req, res) {
  return subscribePlatformActivityEvents(req, res);
}
