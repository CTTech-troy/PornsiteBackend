import fs from 'fs';
import path from 'path';
import os from 'os';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import unzipper from 'unzipper';

const MAX_UNCOMPRESSED_BYTES = Number(process.env.IMPORT_MAX_UNCOMPRESSED_BYTES || 5 * 1024 * 1024 * 1024);
const ALLOWED_EXTENSIONS = new Set(['.csv', '.json', '.mp4', '.webm', '.jpg', '.jpeg', '.png', '.webp', '.gif']);

function isPathSafe(baseDir, targetPath) {
  const resolved = path.resolve(baseDir, targetPath);
  return resolved.startsWith(path.resolve(baseDir));
}

export async function createImportWorkDir(jobId) {
  const dir = path.join(os.tmpdir(), `video-import-${jobId}`);
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

export async function cleanupImportWorkDir(workDir) {
  try {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  } catch (_) {}
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
