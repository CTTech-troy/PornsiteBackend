import fs from 'fs';
import path from 'path';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import unzipper from 'unzipper';

const MAX_UNCOMPRESSED_BYTES = Number(process.env.IMPORT_MAX_UNCOMPRESSED_BYTES || 5 * 1024 * 1024 * 1024);
const ALLOWED_EXTENSIONS = new Set(['.csv', '.json', '.mp4', '.webm', '.jpg', '.jpeg', '.png', '.webp', '.gif']);

/** Persistent root for import temp files (survives process restarts for resume). */
export function getImportWorkRoot() {
  const configured = String(process.env.IMPORT_WORK_ROOT || '').trim();
  if (configured) return path.resolve(configured);
  return path.resolve(process.cwd(), 'temp', 'video-imports');
}

export function getJobWorkDir(jobId) {
  return path.join(getImportWorkRoot(), String(jobId));
}

export function getLocalSourcePath(workDir, sourceFormat) {
  const fmt = String(sourceFormat || 'csv').toLowerCase();
  if (fmt === 'zip') return path.join(workDir, 'source.zip');
  if (fmt === 'gz') return path.join(workDir, 'source.gz');
  return path.join(workDir, 'source.csv.gz');
}

export function getLocalChunkPath(workDir, batchNo) {
  const padded = String(batchNo).padStart(6, '0');
  return path.join(workDir, 'chunks', `chunk-${padded}.ndjson.gz`);
}

function isPathSafe(baseDir, targetPath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  return target === base || target.startsWith(`${base}${path.sep}`);
}

export async function createImportWorkDir(jobId) {
  const dir = getJobWorkDir(jobId);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.mkdir(path.join(dir, 'chunks'), { recursive: true });
  return dir;
}

export async function cleanupImportWorkDir(workDir) {
  if (!workDir) return;
  try {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  } catch (_) {}
}

export async function cleanupImportJobFiles(job) {
  if (!job) return;
  const workDir = job.metadata?.workDir || getJobWorkDir(job.id);
  await cleanupImportWorkDir(workDir);
}

export function resolveJobSourcePath(job) {
  const staging = String(job?.staging_path || '').trim();
  if (staging && path.isAbsolute(staging)) return staging;

  const workDir = job?.metadata?.workDir || getJobWorkDir(job?.id);
  const fmt = String(job?.source_format || 'csv').toLowerCase();
  return getLocalSourcePath(workDir, fmt);
}

export async function statJobSourceFile(job) {
  const sourcePath = resolveJobSourcePath(job);
  const stat = await fs.promises.stat(sourcePath);
  return { sourcePath, size: stat.size };
}

export async function extractGzToFile(gzPath, destPath) {
  const stat = await fs.promises.stat(gzPath);
  if (stat.size > MAX_UNCOMPRESSED_BYTES) {
    throw new Error('GZ file exceeds max size');
  }
  await pipeline(
    fs.createReadStream(gzPath),
    createGunzip(),
    createWriteStream(destPath),
  );
  return destPath;
}

export async function extractZipToDir(zipPath, destDir) {
  let total = 0;
  const directory = await unzipper.Open.file(zipPath);
  for (const entry of directory.files) {
    if (entry.type === 'Directory') continue;
    const name = entry.path;
    if (name.includes('..') || name.startsWith('/') || name.includes('\\..')) {
      throw new Error('Unsafe path in ZIP archive');
    }
    const ext = path.extname(name).toLowerCase();
    if (ext && !ALLOWED_EXTENSIONS.has(ext)) continue;

    const dest = path.join(destDir, name);
    if (!isPathSafe(destDir, dest)) throw new Error('Zip slip detected');

    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    const size = entry.uncompressedSize || 0;
    total += size;
    if (total > MAX_UNCOMPRESSED_BYTES) throw new Error('ZIP extract exceeds max size');
    await pipeline(entry.stream(), createWriteStream(dest));
  }
  return destDir;
}

async function walkDir(dir) {
  const out = [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...await walkDir(full));
    else out.push(full);
  }
  return out;
}

export async function findCsvInDir(dir) {
  const files = await walkDir(dir);
  return files.find((f) => f.toLowerCase().endsWith('.csv')) || null;
}

export async function extractArchiveToWorkDir({ sourcePath, sourceFormat, workDir }) {
  if (sourceFormat === 'csv') {
    const dest = path.join(workDir, 'catalog.csv');
    await fs.promises.copyFile(sourcePath, dest);
    return { csvPath: dest, mediaDir: workDir };
  }
  if (sourceFormat === 'gz') {
    const dest = path.join(workDir, 'catalog.csv');
    await extractGzToFile(sourcePath, dest);
    return { csvPath: dest, mediaDir: workDir };
  }
  if (sourceFormat === 'zip') {
    await extractZipToDir(sourcePath, workDir);
    const csvPath = await findCsvInDir(workDir);
    if (!csvPath) throw new Error('No CSV file found in ZIP archive');
    return { csvPath, mediaDir: workDir };
  }
  throw new Error(`Unsupported source format: ${sourceFormat}`);
}
