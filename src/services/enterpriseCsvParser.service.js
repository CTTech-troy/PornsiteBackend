import { createHash } from 'crypto';
import { Readable } from 'stream';
import { parse } from 'csv-parse';
import { isDirectPlayableStreamUrl, isSafeHttpUrl } from '../utils/videoPlaybackValidation.js';

const RAW_SEMICOLON_MIN_FIELDS = 6;
const DEFAULT_CSV_DELIMITER = String(process.env.ENTERPRISE_IMPORT_CSV_DELIMITER || ';').slice(0, 1) || ';';
const MAX_RECORD_SIZE_BYTES = Math.max(
  1024 * 1024,
  Number(process.env.ENTERPRISE_IMPORT_CSV_MAX_RECORD_BYTES || 20 * 1024 * 1024),
);
const IFRAME_KEY_PATTERN = /^(iframe_embed|iframe|iframe_html|embed_html|raw_html|html|embed|embed_code|iframe_code)$/i;
const HTML_PATTERN = /<\/?[a-z][\s\S]*>/i;

const COLUMN_ALIASES = {
  video_url: ['video_url', 'videourl', 'url', 'link', 'source_url', 'source', 'watch_url', 'page_url'],
  iframe_embed: ['iframe_embed', 'iframe', 'iframe_html', 'embed_html', 'raw_html', 'html', 'embed', 'embed_code', 'iframe_code'],
  title: ['title', 'name', 'video_title'],
  duration: ['duration', 'duration_seconds', 'duration_sec', 'length', 'runtime'],
  thumbnail_url: ['thumbnail_url', 'thumbnail', 'thumb', 'thumb_url', 'poster', 'poster_url'],
  tags: ['tags', 'tag', 'keywords'],
  actors: ['actors', 'actor', 'models', 'performers', 'stars'],
  views: ['views', 'view_count', 'views_count'],
  category: ['category', 'categories', 'main_orientation_category', 'orientation'],
  quality: ['quality', 'resolution'],
  studio: ['studio', 'provider', 'site', 'source_provider'],
  publish_date: ['publish_date', 'published_at', 'date', 'created_at', 'created_date'],
};

const KNOWN_HEADER_NAMES = new Set([
  ...Object.values(COLUMN_ALIASES).flat(),
]);

function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

function decodeBasicHtmlEntities(value) {
  return String(value ?? '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripHtml(value) {
  return decodeBasicHtmlEntities(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsIframe(value) {
  return /<iframe\b/i.test(String(value || ''));
}

function firstHttpUrl(value) {
  const text = decodeBasicHtmlEntities(value);
  const markdown = text.match(/\[([a-z][a-z0-9+.-]*:\/\/[^\]\s]+)\]\(([^)\s]+)\)/i);
  const candidate = markdown?.[1] || markdown?.[2] || text.match(/https?:\/\/[^\s<>"'\]\);]+/i)?.[0] || '';
  return candidate.replace(/[.,]+$/g, '').trim();
}

function cleanUrlField(value) {
  const candidate = firstHttpUrl(value) || stripHtml(value);
  if (!candidate || !isSafeHttpUrl(candidate)) return '';
  return candidate;
}

function cleanIframeEmbedField(value) {
  if (value == null) return '';
  const raw = String(value).trim();
  if (!raw || !containsIframe(raw)) return '';
  return raw;
}

function cleanTextField(value, max = 1000) {
  return stripHtml(value).slice(0, max);
}

function cleanList(value) {
  if (Array.isArray(value)) return value.map((entry) => cleanTextField(entry, 120)).filter(Boolean);
  const text = cleanTextField(value, 5000);
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return cleanList(parsed);
    } catch {
      // Fall through to delimiter parsing.
    }
  }
  return text.split(/[,|;]/).map((entry) => cleanTextField(entry, 120)).filter(Boolean);
}

function parseInteger(value) {
  const text = cleanTextField(value, 80).replace(/[^\d-]/g, '');
  if (!text) return 0;
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseDurationSeconds(value) {
  const text = cleanTextField(value, 80).toLowerCase();
  if (!text) return null;
  if (/^\d+(?::\d{1,2}){1,2}$/.test(text)) {
    return text.split(':').reduce((total, part) => (total * 60) + Number(part || 0), 0);
  }
  const number = Number.parseFloat(text.replace(/,/g, ''));
  if (!Number.isFinite(number)) return null;
  if (/\b(hours?|hrs?|h)\b/.test(text)) return Math.round(number * 3600);
  if (/\b(minutes?|mins?|m)\b/.test(text)) return Math.round(number * 60);
  return Math.max(0, Math.round(number));
}

function normalizePublishDate(value) {
  const text = cleanTextField(value, 120);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function normalizeVideoUrl(value) {
  const url = cleanUrlField(value);
  if (!url) return '';
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/g, '').toLowerCase();
  } catch {
    return url.trim().replace(/\/+$/g, '').toLowerCase();
  }
}

export function computeVideoFingerprint(videoUrl) {
  return createHash('sha256').update(normalizeVideoUrl(videoUrl)).digest('hex');
}

function cleanMetadataValue(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(cleanMetadataValue).filter((entry) => entry != null && entry !== '');
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (IFRAME_KEY_PATTERN.test(key)) continue;
      const cleaned = cleanMetadataValue(entry);
      if (cleaned != null && cleaned !== '' && !(Array.isArray(cleaned) && cleaned.length === 0)) out[key] = cleaned;
    }
    return out;
  }
  if (typeof value === 'string') {
    if (containsIframe(value)) return value.trim().slice(0, 5000);
    return HTML_PATTERN.test(value) ? cleanTextField(value, 1000) : value.trim().slice(0, 1000);
  }
  return value;
}

function sanitizeMetadata(metadata = {}) {
  const out = {};
  for (const [key, value] of Object.entries(metadata || {})) {
    if (IFRAME_KEY_PATTERN.test(key)) continue;
    const cleaned = cleanMetadataValue(value);
    if (cleaned != null && cleaned !== '' && !(Array.isArray(cleaned) && cleaned.length === 0)) out[key] = cleaned;
  }
  return out;
}

function hasKnownHeader(fields) {
  const normalized = fields.map(normalizeHeader).filter(Boolean);
  if (!normalized.length) return false;
  const matches = normalized.filter((field) => KNOWN_HEADER_NAMES.has(field));
  return matches.length >= 2 || (matches.length >= 1 && normalized.length <= 8);
}

function looksLikeRawSemicolonRow(line) {
  const trimmed = String(line || '').replace(/^\uFEFF/, '').trim();
  if (!trimmed || !trimmed.includes(';')) return false;
  const fields = trimmed.split(';');
  if (hasKnownHeader(fields)) return false;
  return fields.length >= RAW_SEMICOLON_MIN_FIELDS;
}

function headerDelimiterForLine(line) {
  if (DEFAULT_CSV_DELIMITER === ';' && String(line || '').includes(';')) return ';';
  const semicolonFields = String(line || '').split(';');
  const commaFields = String(line || '').split(',');
  if (semicolonFields.length > commaFields.length && hasKnownHeader(semicolonFields)) return ';';
  if (commaFields.length > semicolonFields.length && hasKnownHeader(commaFields)) return ',';
  return DEFAULT_CSV_DELIMITER;
}

function firstNonEmptyLine(text) {
  return String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).find((line) => line.trim()) || '';
}

async function replayableStreamWithFirstLine(readable) {
  const startedAt = Date.now();
  const iterator = readable[Symbol.asyncIterator]();
  const chunks = [];
  let inspected = '';
  let inspectedBytes = 0;

  while ((!firstNonEmptyLine(inspected) || !/\r?\n/.test(inspected)) && inspected.length < 1024 * 1024) {
    const next = await iterator.next();
    if (next.done) break;
    chunks.push(next.value);
    const chunkText = Buffer.isBuffer(next.value) ? next.value.toString('utf8') : String(next.value);
    inspected += chunkText;
    inspectedBytes += Buffer.isBuffer(next.value) ? next.value.length : Buffer.byteLength(chunkText);
  }

  async function* replay() {
    for (const chunk of chunks) yield chunk;
    for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) yield chunk;
  }

  return {
    firstLine: firstNonEmptyLine(inspected),
    stream: Readable.from(replay()),
    inspectedBytes,
    probeMs: Date.now() - startedAt,
  };
}

function mapHeaderedRecord(headers, record) {
  const normalized = {};
  headers.forEach((header, index) => {
    const key = normalizeHeader(header);
    if (!key) return;
    normalized[key] = record[index];
  });

  const raw = {};
  const consumed = new Set();
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) {
      if (normalized[alias] != null && normalized[alias] !== '') {
        raw[field] = normalized[alias];
        consumed.add(alias);
        break;
      }
    }
  }

  const metadata = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (consumed.has(key) || IFRAME_KEY_PATTERN.test(key) || containsIframe(value)) continue;
    const cleaned = cleanMetadataValue(value);
    if (cleaned != null && cleaned !== '') metadata[key] = cleaned;
  }
  if (Object.keys(metadata).length) raw.metadata = metadata;
  return raw;
}

export function parseRawSemicolonVideoRow(line) {
  const fields = String(line || '').split(';').map((field) => field.trim());
  return parseRawSemicolonVideoRecord(fields);
}

export function parseRawSemicolonVideoRecord(record) {
  const fields = (Array.isArray(record) ? record : []).map((field) => String(field ?? '').trim());
  const metadata = {};

  fields.forEach((field, index) => {
    if ([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12].includes(index)) return;
    const cleaned = cleanMetadataValue(field);
    if (cleaned != null && cleaned !== '') metadata[`field_${index}`] = cleaned;
  });

  return {
    video_url: fields[0],
    title: fields[1],
    duration: fields[2],
    thumbnail_url: fields[3],
    iframe_embed: fields[4],
    tags: fields[5],
    actors: fields[6],
    views: fields[7],
    category: fields[8],
    quality: fields[9],
    studio: fields[10],
    publish_date: fields[12],
    metadata: sanitizeMetadata({
      ...metadata,
      raw_format: 'semicolon',
    }),
  };
}

export function normalizeEnterpriseVideoRow(raw = {}) {
  const videoUrl = cleanUrlField(raw.video_url);
  if (!videoUrl) {
    return { error: 'MISSING_VIDEO_URL', message: 'video_url is required and must be a safe http(s) URL' };
  }

  const title = cleanTextField(raw.title, 500) || 'Untitled';
  const thumbnailUrl = cleanUrlField(raw.thumbnail_url);
  const iframeEmbed = cleanIframeEmbedField(raw.iframe_embed);
  const playbackType = iframeEmbed
    ? 'external_embed'
    : isDirectPlayableStreamUrl(videoUrl, { allowUnapprovedDirectHost: true })
      ? 'internal'
      : 'external_redirect';
  const metadata = sanitizeMetadata(raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {});

  return {
    row: {
      video_url: videoUrl,
      iframe_embed: iframeEmbed || null,
      playback_type: playbackType,
      title,
      duration: parseDurationSeconds(raw.duration),
      thumbnail_url: thumbnailUrl || null,
      tags: cleanList(raw.tags),
      actors: cleanList(raw.actors),
      views: parseInteger(raw.views),
      category: cleanTextField(raw.category, 160) || null,
      quality: cleanTextField(raw.quality, 80) || null,
      studio: cleanTextField(raw.studio, 200) || null,
      publish_date: normalizePublishDate(raw.publish_date),
      metadata,
      video_fingerprint: computeVideoFingerprint(videoUrl),
    },
  };
}

function createCsvParser(readable, {
  delimiter = DEFAULT_CSV_DELIMITER,
  mode = 'csv',
  onParserInitialized = null,
} = {}) {
  const startedAt = Date.now();
  const parser = readable.pipe(parse({
    bom: true,
    delimiter,
    encoding: 'utf8',
    max_record_size: MAX_RECORD_SIZE_BYTES,
    relax_column_count: true,
    relax_quotes: true,
    record_delimiter: ['\r\n', '\n', '\r'],
    skip_empty_lines: true,
    trim: true,
  }));
  if (onParserInitialized) {
    onParserInitialized({
      mode,
      delimiter,
      maxRecordSizeBytes: MAX_RECORD_SIZE_BYTES,
      startupMs: Date.now() - startedAt,
    });
  }
  return parser;
}

async function* streamHeaderedRows(readable, {
  offset = 0,
  normalize = true,
  delimiter = DEFAULT_CSV_DELIMITER,
  onParserInitialized = null,
} = {}) {
  const parser = createCsvParser(readable, {
    delimiter,
    mode: 'headered',
    onParserInitialized,
  });
  let headers = null;
  let rowIndex = -1;

  for await (const record of parser) {
    rowIndex += 1;
    if (!headers) {
      headers = record.map((header) => String(header));
      continue;
    }
    if (rowIndex - 1 < offset) continue;
    const raw = mapHeaderedRecord(headers, record);
    yield normalize
      ? { rowNumber: rowIndex, raw, ...normalizeEnterpriseVideoRow(raw) }
      : { rowNumber: rowIndex, raw };
  }
}

async function* streamRawSemicolonRows(readable, {
  offset = 0,
  normalize = true,
  onParserInitialized = null,
} = {}) {
  const parser = createCsvParser(readable, {
    delimiter: ';',
    mode: 'raw-semicolon',
    onParserInitialized,
  });
  let rowNumber = 0;
  let dataIndex = 0;

  for await (const record of parser) {
    rowNumber += 1;
    const normalizedRecord = (Array.isArray(record) ? record : []).map((field) => String(field ?? '').replace(/^\uFEFF/, '').trim());
    if (!normalizedRecord.some(Boolean)) continue;
    if (dataIndex < offset) {
      dataIndex += 1;
      continue;
    }
    dataIndex += 1;
    const raw = parseRawSemicolonVideoRecord(normalizedRecord);
    yield normalize
      ? { rowNumber, raw, ...normalizeEnterpriseVideoRow(raw) }
      : { rowNumber, raw };
  }
}

export async function* streamEnterpriseCsvRowsFromStream(readable, options = {}) {
  const { firstLine, stream, inspectedBytes, probeMs } = await replayableStreamWithFirstLine(readable);
  if (options.onStreamProbe) {
    options.onStreamProbe({
      firstLinePreview: String(firstLine || '').slice(0, 160),
      inspectedBytes,
      probeMs,
    });
  }
  if (looksLikeRawSemicolonRow(firstLine)) {
    yield* streamRawSemicolonRows(stream, options);
    return;
  }
  yield* streamHeaderedRows(stream, {
    ...options,
    delimiter: headerDelimiterForLine(firstLine),
  });
}

export async function countEnterpriseCsvRowsFromStream(readable, { onProgress = null } = {}) {
  let count = 0;
  for await (const _ of streamEnterpriseCsvRowsFromStream(readable, { normalize: false })) {
    count += 1;
    if (onProgress && count % 50_000 === 0) await onProgress(count);
  }
  if (onProgress) await onProgress(count);
  return count;
}

export function sanitizeFailedRow(raw = {}) {
  return sanitizeMetadata(raw && typeof raw === 'object' ? raw : {});
}
