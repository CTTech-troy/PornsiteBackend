import path from 'path';

const MIME_BY_EXT = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
  ogg: 'video/ogg',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
};

const EXT_BY_MIME = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/ogg': '.ogv',
  'video/quicktime': '.mov',
  'video/x-msvideo': '.avi',
  'video/x-matroska': '.mkv',
};

export function resolveVideoContentType(mimetype, filename) {
  const m = String(mimetype || '').trim().toLowerCase();
  if (m.startsWith('video/') && m !== 'video/unknown' && m !== 'application/octet-stream') {
    return m;
  }
  const base = path.basename(String(filename || ''));
  const ext = (base.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  if (ext && MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  return 'video/mp4';
}

/**
 * Safe basename with a real video extension so Storage URLs and Content-Type stay consistent.
 */
export function ensureVideoFilenameForStorage(originalname, mimetype) {
  const raw = String(originalname || 'video').trim() || 'video';
  const base = path.basename(raw.replace(/\\/g, '/')).replace(/[^a-zA-Z0-9._-]/g, '_') || 'video';
  const hasVideoExt = /\.(mp4|m4v|webm|mov|ogv|ogg|avi|mkv)$/i.test(base);
  if (hasVideoExt) return base;
  const ct = resolveVideoContentType(mimetype, base);
  const ext = EXT_BY_MIME[ct] || '.mp4';
  const stem = base.replace(/\.[^.]+$/, '') || 'video';
  return `${stem}${ext}`;
}
