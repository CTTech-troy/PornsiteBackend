import fs from 'fs';
import { parse } from 'csv-parse';

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

export function normalizeImportRow(raw) {
  const embedUrl = String(raw.embed_url || raw.stream_url || '').trim();
  const title = String(raw.title || '').trim() || 'Untitled';
  if (!embedUrl && !raw.media_file) {
    return { error: 'MISSING_URL', message: 'embed_url or media_file required' };
  }
  let metadata = {};
  if (raw.metadata) {
    try {
      metadata = typeof raw.metadata === 'string' ? JSON.parse(raw.metadata) : raw.metadata;
    } catch {
      metadata = { raw: String(raw.metadata) };
    }
  }
  const premium = parsePremium(raw.premium);
  const tokenPrice = Math.max(0, parseInt(String(raw.token_price || '0'), 10) || 0);
  const accessType = parseAccessType(raw.access_type, premium, tokenPrice);
  return {
    row: {
      title: title.slice(0, 500),
      description: String(raw.description || title).slice(0, 5000),
      tags: parseTags(raw.tags),
      embed_url: embedUrl,
      stream_url: String(raw.stream_url || '').trim() || null,
      thumbnail_url: String(raw.thumbnail || '').trim() || null,
      duration_seconds: Math.max(0, Number(raw.duration) || 0),
      main_orientation_category: String(raw.categories || 'General').split(/[,|;]/)[0].trim() || 'General',
      provider: String(raw.provider || 'import').trim(),
      is_premium_content: premium || accessType !== 'free',
      token_price: accessType === 'coin_unlock' || tokenPrice > 0 ? tokenPrice : 0,
      access_type: accessType,
      requires_membership: accessType === 'members_only' || parseBool(raw.subscription_access),
      subscription_access: parseBool(raw.subscription_access) || accessType === 'members_only',
      premium_visibility: String(raw.premium_visibility || (accessType === 'free' ? 'public' : 'public_preview')).trim(),
      external_id: String(raw.external_id || '').trim() || null,
      media_file: String(raw.media_file || '').trim() || null,
      creator_id: String(raw.creator_id || '').trim() || null,
      metadata,
    },
  };
}

export async function* streamCsvRows(csvPath, { offset = 0 } = {}) {
  const parser = fs.createReadStream(csvPath).pipe(parse({
    bom: true,
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
    const mapped = mapRow(headers, record);
    yield { rowNumber: rowIndex, raw: mapped, ...normalizeImportRow(mapped) };
  }
}

export async function countCsvRows(csvPath) {
  let count = 0;
  for await (const _ of streamCsvRows(csvPath)) {
    count += 1;
  }
  return count;
}
