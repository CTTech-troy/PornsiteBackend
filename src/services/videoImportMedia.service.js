import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { uploadFileToBucket, getPublicUrl, VIDEO_BUCKET, IMAGE_BUCKET } from '../config/supabase.js';
import { scheduleMediaReplication } from './mediaRedundancy.service.js';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.m4v', '.mov']);

function contentTypeForExt(ext) {
  const e = ext.toLowerCase();
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
  if (e === '.png') return 'image/png';
  if (e === '.webp') return 'image/webp';
  if (e === '.gif') return 'image/gif';
  if (e === '.webm') return 'video/webm';
  if (e === '.mp4' || e === '.m4v') return 'video/mp4';
  return 'application/octet-stream';
}

async function findMediaFile(mediaDir, mediaFile) {
  const base = path.basename(mediaFile);
  const direct = path.join(mediaDir, mediaFile);
  if (fs.existsSync(direct)) return direct;
  const byBase = path.join(mediaDir, base);
  if (fs.existsSync(byBase)) return byBase;

  const walk = async (dir) => {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        const found = await walk(full);
        if (found) return found;
      } else if (ent.name === base || ent.name === mediaFile) {
        return full;
      }
    }
    return null;
  };
  return walk(mediaDir);
}

export async function resolveMediaUrls({ mediaDir, mediaFile, importJobId }) {
  if (!mediaFile || !mediaDir) return { storageUrl: null, thumbnailUrl: null };
  const filePath = await findMediaFile(mediaDir, mediaFile);
  if (!filePath) return { storageUrl: null, thumbnailUrl: null };

  const ext = path.extname(filePath).toLowerCase();
  const uid = `import-${importJobId || 'system'}`;
  const stamp = Date.now();
  const safeName = path.basename(filePath).replace(/[^a-zA-Z0-9._-]/g, '_');

  if (IMAGE_EXT.has(ext)) {
    const thumbPath = `imports/${uid}/${stamp}-${safeName}`;
    await uploadFileToBucket(IMAGE_BUCKET, thumbPath, { path: filePath }, contentTypeForExt(ext));
    scheduleMediaReplication({
      sourceTable: 'import_media',
      sourceId: importJobId || thumbPath,
      mediaType: 'image',
      primaryBucket: IMAGE_BUCKET,
      primaryPath: thumbPath,
      primaryUrl: getPublicUrl(IMAGE_BUCKET, thumbPath),
      contentType: contentTypeForExt(ext),
    });
    return { storageUrl: null, thumbnailUrl: getPublicUrl(IMAGE_BUCKET, thumbPath) };
  }

  if (VIDEO_EXT.has(ext)) {
    const videoPath = `imports/${uid}/${stamp}-${safeName}`;
    await uploadFileToBucket(VIDEO_BUCKET, videoPath, { path: filePath }, contentTypeForExt(ext));
    const publicUrl = getPublicUrl(VIDEO_BUCKET, videoPath);
    scheduleMediaReplication({
      sourceTable: 'import_media',
      sourceId: importJobId || videoPath,
      mediaType: 'video',
      primaryBucket: VIDEO_BUCKET,
      primaryPath: videoPath,
      primaryUrl: publicUrl,
      contentType: contentTypeForExt(ext),
    });
    return { storageUrl: publicUrl, thumbnailUrl: null };
  }

  return { storageUrl: null, thumbnailUrl: null };
}

export async function uploadRemoteThumbnail(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed.startsWith('http')) return trimmed || null;
  try {
    const fetch = (await import('node-fetch')).default;
    const res = await fetch(trimmed, { timeout: 15000 });
    if (!res.ok) return trimmed;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > 5 * 1024 * 1024) return trimmed;
    const thumbPath = `imports/thumbs/${randomUUID()}.jpg`;
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    await uploadFileToBucket(IMAGE_BUCKET, thumbPath, buffer, contentType);
    const primaryUrl = getPublicUrl(IMAGE_BUCKET, thumbPath);
    scheduleMediaReplication({
      sourceTable: 'import_media',
      sourceId: thumbPath,
      mediaType: 'image',
      primaryBucket: IMAGE_BUCKET,
      primaryPath: thumbPath,
      primaryUrl,
      contentType,
    });
    return primaryUrl || trimmed;
  } catch {
    return trimmed;
  }
}
