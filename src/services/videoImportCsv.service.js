import fs from 'fs';
import { createInterface } from 'readline';
import { Readable } from 'stream';
import { parse } from 'csv-parse';
import {
  isApprovedEmbedUrl,
  isDirectPlayableStreamUrl,
  isSafeHttpUrl,
} from '../utils/videoPlaybackValidation.js';

const COLUMN_ALIASES = {
  title: ['title', 'name', 'video_title'],
  tags: ['tags', 'tag', 'keywords'],
  embed_url: ['embed_url', 'embedurl', 'embed', 'url', 'video_url', 'link'],
  thumbnail: ['thumbnail', 'thumb', 'thumbnail_url', 'thumb_url', 'poster'],
  duration: ['duration', 'duration_seconds', 'length', 'runtime'],
  categories: ['categories', 'category', 'main_orientation_category', 'orientation'],
  provider: ['provider', 'source_provider', 'site'],
  premium: ['premium', 'is_premium', 'is_premium_content', 'premium_status'],
  token_price: ['token_price', 'coin_price', 'tokens', 'price', 'coin_unlock_price'],
  access_type: ['access_type', 'premium_access', 'access', 'monetization_type'],
  premium_visibility: ['premium_visibility', 'premium_visibility_mode', 'visibility_mode'],
  subscription_access: ['subscription_access', 'members_access', 'membership_access', 'subscriber_access'],
  metadata: ['metadata', 'meta', 'extra'],
  external_id: ['external_id', 'externalid', 'id', 'video_id'],
  media_file: ['media_file', 'media_path', 'file', 'filename', 'video_file'],
  creator_id: ['creator_id', 'user_id', 'creator'],
  stream_url: ['stream_url', 'streamurl', 'direct_url', 'mp4'],
  description: ['description', 'desc'],
};
const KNOWN_HEADER_NAMES = new Set(Object.values(COLUMN_ALIASES).flat());
const RAW_SEMICOLON_MIN_FIELDS = 6;

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function mapRow(headers, record) {
  const normalized = {};
  headers.forEach((h, i) => {
    normalized[normalizeHeader(h)] = record[i];
  });
  const out = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) {
      if (normalized[alias] != null && normalized[alias] !== '') {
        out[field] = normalized[alias];
        break;
      }
    }
  }
  return out;
}

function hasKnownHeader(fields) {
  const normalized = fields.map(normalizeHeader).filter(Boolean);
  if (!normalized.length) return false;
  const matches = normalized.filter((field) => KNOWN_HEADER_NAMES.has(field));
  return matches.length >= 2 || (matches.length >= 1 && normalized.length <= 8);
}

function parseTags(val) {
  if (Array.isArray(val)) return val.map(String).filter(Boolean);
  const s = String(val || '').trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return s.split(/[,|;]/).map((t) => t.trim()).filter(Boolean);
}

function parseList(val) {
  if (Array.isArray(val)) return val.map((item) => stripHtml(item)).filter(Boolean);
  const s = stripHtml(val || '');
  if (!s) return [];
  return s.split(/[,|]/).map((item) => stripHtml(item)).filter(Boolean);
}

function parseInteger(val) {
  const s = stripHtml(val || '').replace(/[^\d-]/g, '');
  if (!s) return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function parseDurationSeconds(val) {
  const s = stripHtml(val || '').toLowerCase();
  if (!s) return 0;
  if (/^\d+(?::\d{1,2}){1,2}$/.test(s)) {
    return s.split(':').reduce((total, part) => (total * 60) + Number(part || 0), 0);
  }
  const number = Number.parseFloat(s.replace(/,/g, ''));
  if (!Number.isFinite(number)) return 0;
  if (/\b(hours?|hrs?|h)\b/.test(s)) return Math.round(number * 3600);
  if (/\b(minutes?|mins?|m)\b/.test(s)) return Math.round(number * 60);
  return Math.max(0, Math.round(number));
}

function normalizeDateValue(val) {
  const s = stripHtml(val || '');
  if (!s) return null;
  const date = new Date(s);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function parsePremium(val) {
  const s = String(val || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'premium', 'paid'].includes(s);
}

function parseAccessType(raw, premium, tokenPrice) {
  const s = String(raw || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['premium', 'members_only', 'coin_unlock', 'free'].includes(s)) return s;
  if (['member', 'members', 'membership', 'subscriber', 'subscribers_only'].includes(s)) return 'members_only';
  if (['coin', 'coins', 'paid', 'pay_per_view', 'token', 'tokens'].includes(s)) return 'coin_unlock';
  if (Number(tokenPrice || 0) > 0) return 'coin_unlock';
  return premium ? 'premium' : 'free';
}

function parseBool(val) {
  const s = String(val || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'member', 'members', 'membership', 'subscriber'].includes(s);
}

function decodeBasicHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function extractIframeSrc(value) {
  const html = decodeBasicHtmlEntities(value);
  const match = html.match(/<iframe[^>]*\bsrc=["']([^"']+)["']/i);
  return match?.[1]?.trim() || '';
}

function stripHtml(value) {
  return decodeBasicHtmlEntities(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanUrlField(value) {
  const iframeSrc = extractIframeSrc(value);
  const cleaned = iframeSrc || stripHtml(value);
  if (!cleaned) return '';
  if (!isSafeHttpUrl(cleaned)) return '';
  return cleaned;
}

function removeIframeHtml(value) {
  return decodeBasicHtmlEntities(value)
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<iframe\b[^>]*\/?>/gi, '');
}

function cleanTextField(value) {
  return stripHtml(removeIframeHtml(value));
}

function cleanMetadataValue(value) {
  if (Array.isArray(value)) return value.map(cleanMetadataValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cleanMetadataValue(entry)]),
    );
  }
  if (typeof value === 'string') {
    const iframeSrc = extractIframeSrc(value);
    return iframeSrc || stripHtml(value);
  }
  return value;
}

function sanitizeImportRawFields(raw = {}) {
  const out = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (value == null) continue;
    if (['embed_url', 'stream_url', 'video_url', 'source_url', 'url', 'thumbnail'].includes(key)) {
      const cleaned = cleanUrlField(value);
      if (cleaned) out[key] = cleaned;
      continue;
    }
    if (key === 'metadata' && value && typeof value === 'object') {
      out[key] = cleanMetadataValue(value);
      continue;
    }
    const cleaned = cleanTextField(value);
    if (cleaned !== '') out[key] = cleaned;
  }
  return out;
}

function normalizeSourceFields(raw) {
  const candidates = [
    raw.stream_url,
    raw.video_url,
    raw.source_url,
    raw.url,
    raw.embed_url,
  ].map(cleanUrlField).filter(Boolean);

  const direct = candidates.find((candidate) => isDirectPlayableStreamUrl(candidate)) || '';
  if (direct) {
    return {
      embedUrl: '',
      streamUrl: direct,
      sourceUrl: direct,
      sourceKind: 'direct_stream',
    };
  }

  const officialEmbed = candidates.find((candidate) => isApprovedEmbedUrl(candidate)) || '';
  if (officialEmbed) {
    return {
      embedUrl: officialEmbed,
      streamUrl: '',
      sourceUrl: officialEmbed,
      sourceKind: 'official_embed',
    };
  }

  const externalUrl = candidates[0] || '';
  if (externalUrl) {
    return {
      embedUrl: '',
      streamUrl: '',
      sourceUrl: externalUrl,
      sourceKind: 'external_page',
    };
  }
  return { embedUrl: '', streamUrl: '', sourceUrl: '', sourceKind: raw.media_file ? 'media_file' : 'missing' };
}

function looksLikeRawSemicolonRow(line) {
  const trimmed = String(line || '').replace(/^\uFEFF/, '').trim();
  if (!trimmed || !trimmed.includes(';')) return false;
  const fields = trimmed.split(';');
  if (hasKnownHeader(fields)) return false;
  return fields.length >= RAW_SEMICOLON_MIN_FIELDS;
}

function headerDelimiterForLine(line) {
  const semicolonFields = String(line || '').split(';');
  const commaFields = String(line || '').split(',');
  if (semicolonFields.length > commaFields.length && hasKnownHeader(semicolonFields)) return ';';
  return ',';
}

function firstNonEmptyLine(text) {
  return String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).find((line) => line.trim()) || '';
}

async function replayableStreamWithFirstLine(readable) {
  const iterator = readable[Symbol.asyncIterator]();
  const chunks = [];
  let inspected = '';

  while ((!firstNonEmptyLine(inspected) || !/\r?\n/.test(inspected)) && inspected.length < 1024 * 1024) {
    const next = await iterator.next();
    if (next.done) {
      break;
    }
    chunks.push(next.value);
    inspected += Buffer.isBuffer(next.value) ? next.value.toString('utf8') : String(next.value);
  }

  async function* replay() {
    for (const chunk of chunks) yield chunk;
    for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) {
      yield chunk;
    }
  }

  return {
    firstLine: firstNonEmptyLine(inspected),
    stream: Readable.from(replay()),
  };
}

export function parseRawSemicolonRow(line) {
  const iframeRemoved = /<iframe\b/i.test(String(line || ''));
  const cleanedLine = removeIframeHtml(line);
  const fields = cleanedLine.split(';').map((field) => cleanTextField(field));
  const raw = {
    video_url: cleanUrlField(fields[0]),
    title: fields[1],
    duration: fields[2],
    thumbnail: cleanUrlField(fields[3]),
    tags: fields[5],
    actors: fields[6],
    views: fields[7],
    categories: fields[8],
    quality: fields[9],
    provider: fields[10],
    created_at: fields[12],
    metadata: {
      rawFormat: 'semicolon',
      iframeRemoved,
    },
  };
  return sanitizeImportRawFields(raw);
}

export function normalizeImportRow(raw) {
  const source = normalizeSourceFields(raw);
  const mediaFile = stripHtml(raw.media_file || '');
  const title = stripHtml(raw.title || '') || 'Untitled';
  if (!source.sourceUrl && !mediaFile) {
    return { error: 'MISSING_URL', message: 'embed_url or media_file required' };
  }
  let metadata = {};
  if (raw.metadata) {
    try {
      metadata = typeof raw.metadata === 'string' ? JSON.parse(raw.metadata) : raw.metadata;
    } catch {
      metadata = { metadata_text: stripHtml(raw.metadata) };
    }
  }
  metadata = cleanMetadataValue(metadata);
  const actors = parseList(raw.actors);
  const views = parseInteger(raw.views);
  const quality = stripHtml(raw.quality || '');
  const createdAt = normalizeDateValue(raw.created_at || raw.created_date || raw.date);
  const studio = stripHtml(raw.studio || raw.provider || '');
  const premium = parsePremium(raw.premium);
  const tokenPrice = Math.max(0, parseInt(String(raw.token_price || '0'), 10) || 0);
  const accessType = parseAccessType(raw.access_type, premium, tokenPrice);
  return {
    row: {
      title: title.slice(0, 500),
      description: (stripHtml(raw.description || '') || title).slice(0, 5000),
      tags: parseTags(raw.tags).map(stripHtml).filter(Boolean),
      embed_url: source.embedUrl || null,
      stream_url: source.streamUrl || null,
      thumbnail_url: cleanUrlField(raw.thumbnail) || null,
      duration_seconds: parseDurationSeconds(raw.duration),
      main_orientation_category: stripHtml(raw.categories || raw.category || 'General').split(/[,|;]/)[0].trim() || 'General',
      provider: studio || 'import',
      is_premium_content: premium || accessType !== 'free',
      token_price: accessType === 'coin_unlock' || tokenPrice > 0 ? tokenPrice : 0,
      access_type: accessType,
      requires_membership: accessType === 'members_only' || parseBool(raw.subscription_access),
      subscription_access: parseBool(raw.subscription_access) || accessType === 'members_only',
      premium_visibility: stripHtml(raw.premium_visibility || (accessType === 'free' ? 'public' : 'public_preview')),
      external_id: stripHtml(raw.external_id || '') || null,
      media_file: mediaFile || null,
      creator_id: stripHtml(raw.creator_id || '') || null,
      metadata: {
        ...metadata,
        ...(actors.length ? { actors } : {}),
        ...(views != null ? { views } : {}),
        ...(quality ? { quality } : {}),
        ...(studio ? { studio } : {}),
        ...(createdAt ? { created_at: createdAt } : {}),
        importSource: {
          url: source.sourceUrl || null,
          kind: source.sourceKind,
          htmlStripped: /<iframe|<[^>]+>/i.test(String(raw.embed_url || raw.stream_url || raw.video_url || raw.metadata || '')) || Boolean(metadata.iframeRemoved),
        },
      },
    },
  };
}

async function* streamHeaderedCsvRowsFromStream(readable, { offset = 0, normalize = true, delimiter = ',' } = {}) {
  const parser = readable.pipe(parse({
    bom: true,
    delimiter,
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
  }));

  let headers = null;
  let rowIndex = -1;

  for await (const record of parser) {
    rowIndex += 1;
    if (!headers) {
      headers = record.map((h) => String(h));
      continue;
    }
    if (rowIndex - 1 < offset) continue;
    const mapped = sanitizeImportRawFields(mapRow(headers, record));
    yield normalize
      ? { rowNumber: rowIndex, raw: mapped, ...normalizeImportRow(mapped) }
      : { rowNumber: rowIndex, raw: mapped };
  }
}

async function* streamRawSemicolonRowsFromStream(readable, { offset = 0, normalize = true } = {}) {
  const lines = createInterface({ input: readable, crlfDelay: Infinity });
  let rowNumber = 0;
  let dataIndex = 0;

  for await (const line of lines) {
    rowNumber += 1;
    const trimmed = String(line || '').replace(/^\uFEFF/, '').trim();
    if (!trimmed) continue;
    if (dataIndex < offset) {
      dataIndex += 1;
      continue;
    }
    dataIndex += 1;
    const mapped = parseRawSemicolonRow(trimmed);
    yield normalize
      ? { rowNumber, raw: mapped, ...normalizeImportRow(mapped) }
      : { rowNumber, raw: mapped };
  }
}

export async function* streamCsvRowsFromStream(readable, options = {}) {
  const { firstLine, stream } = await replayableStreamWithFirstLine(readable);
  if (looksLikeRawSemicolonRow(firstLine)) {
    yield* streamRawSemicolonRowsFromStream(stream, options);
    return;
  }
  yield* streamHeaderedCsvRowsFromStream(stream, {
    ...options,
    delimiter: headerDelimiterForLine(firstLine),
  });
}

export async function* streamCsvRows(csvPath, options = {}) {
  yield* streamCsvRowsFromStream(fs.createReadStream(csvPath), options);
}

export async function countCsvRows(csvPath) {
  return countCsvRowsFromStream(fs.createReadStream(csvPath));
}

/** Stream through CSV once and count data rows without loading the file into memory. */
export async function countCsvRowsFromStream(readable) {
  let count = 0;
  for await (const _ of streamCsvRowsFromStream(readable, { normalize: false })) {
    count += 1;
  }
  return count;
}
