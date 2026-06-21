import { randomUUID } from 'crypto';
import { supabase } from '../config/supabase.js';
import { validateVideoPlaybackSource } from '../utils/videoPlaybackValidation.js';
import { computeImportHash } from './videoImport.service.js';
import { resolveMediaUrls, uploadRemoteThumbnail } from './videoImportMedia.service.js';
import { indexVideoRow, enqueueSearchIndex } from './searchIndex.service.js';
import { invalidateTopCreatorsCache } from './creatorLeaderboard.service.js';
import { applyOfficialCompanyOwnership } from './officialCompany.service.js';

const HTML_FIELD_PATTERN = /<iframe\b|<\/?[a-z][\s\S]*>/i;

function stripUnsafeHtmlString(value) {
  if (typeof value !== 'string') return value;
  if (!HTML_FIELD_PATTERN.test(value)) return value;
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<iframe\b[^>]*\/?>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizePersistedMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const blockedKeys = new Set(['iframe', 'iframe_html', 'embed_html', 'raw_html', 'html', 'embed']);
  const out = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (blockedKeys.has(String(key).toLowerCase())) continue;
    if (typeof value === 'string') {
      const cleaned = stripUnsafeHtmlString(value);
      if (cleaned) out[key] = cleaned;
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = sanitizePersistedMetadata(value);
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) => (typeof item === 'string' ? stripUnsafeHtmlString(item) : item)).filter(Boolean);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function isMissingColumn(err) {
  return err?.code === 'PGRST204' || err?.code === '42703' || /schema cache/i.test(String(err?.message || ''));
}

function cleanPayloadText(value) {
  return String(value ?? '').trim();
}

function hasPersistablePlaybackSource(row = {}) {
  return [
    row.storage_url,
    row.stream_url,
    row.embed_url,
    row.playback_url,
  ].some((value) => cleanPayloadText(value));
}

async function upsertVideoRow(row) {
  if (!hasPersistablePlaybackSource(row)) {
    const err = new Error('Refusing to upsert empty video row without a playback source.');
    err.code = 'EMPTY_VIDEO_PAYLOAD';
    throw err;
  }

  let payload = { ...row };
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const { data, error } = await supabase.from('tiktok_videos').upsert([payload], {
      onConflict: 'import_hash',
      ignoreDuplicates: false,
    }).select('*').single();

    if (!error) return { action: 'upserted', data };

    if (error.code === '42P10' || /no unique|on conflict/i.test(String(error.message))) {
      const { data: existing } = await supabase.from('tiktok_videos').select('*').eq('import_hash', row.import_hash).maybeSingle();
      if (existing) {
        const { data: updated, error: updateErr } = await supabase.from('tiktok_videos').update(payload).eq('video_id', existing.video_id).select('*').single();
        if (!updateErr) return { action: 'updated', data: updated };
      }
      const { data: inserted, error: insertErr } = await supabase.from('tiktok_videos').insert([payload]).select('*').single();
      if (!insertErr) return { action: 'inserted', data: inserted };
      if (!isMissingColumn(insertErr)) throw insertErr;
      const col = String(insertErr.message || '').match(/'([^']+)'/)?.[1];
      if (col && col in payload) {
        delete payload[col];
        continue;
      }
      throw insertErr;
    }

    if (!isMissingColumn(error)) throw error;
    const col = String(error.message || '').match(/'([^']+)'/)?.[1];
    if (col && col in payload) {
      delete payload[col];
      continue;
    }
    throw error;
  }
  throw new Error('Failed to upsert video row');
}

export async function upsertVideoPayloadBatch(rows) {
  const inputRows = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!inputRows.length) return { action: 'upserted', data: [] };
  const emptyPayload = inputRows.find((row) => !hasPersistablePlaybackSource(row));
  if (emptyPayload) {
    const err = new Error('Refusing to upsert empty video row without a playback source.');
    err.code = 'EMPTY_VIDEO_PAYLOAD';
    throw err;
  }

  let payloads = inputRows.map((row) => ({ ...row }));
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const { data, error } = await supabase.from('tiktok_videos').upsert(payloads, {
      onConflict: 'import_hash',
      ignoreDuplicates: false,
    }).select('*');

    if (!error) return { action: 'upserted', data: data || payloads };

    if (error.code === '42P10' || /no unique|on conflict/i.test(String(error.message))) {
      const data = [];
      for (const payload of payloads) {
        const result = await upsertVideoRow(payload);
        if (result?.data) data.push(result.data);
      }
      return { action: 'upserted', data };
    }

    if (!isMissingColumn(error)) throw error;
    const col = String(error.message || '').match(/'([^']+)'/)?.[1];
    if (col && payloads.some((row) => col in row)) {
      payloads = payloads.map((row) => {
        const next = { ...row };
        delete next[col];
        return next;
      });
      continue;
    }
    throw error;
  }
  throw new Error('Failed to upsert video row batch');
}

export async function prepareVideoImportPayload({
  job,
  parsedRow,
  mediaDir,
  importType,
}) {
  const row = parsedRow.row;
  const importHash = computeImportHash(row);
  const videoId = row.external_id && /^[a-zA-Z0-9_-]{8,128}$/.test(row.external_id)
    ? row.external_id
    : `imp-${randomUUID().slice(0, 12)}`;

  let storageUrl = row.stream_url || null;
  let thumbnailUrl = row.thumbnail_url || null;

  if (row.media_file && mediaDir) {
    const media = await resolveMediaUrls({
      mediaDir,
      mediaFile: row.media_file,
      importJobId: job.id,
    });
    storageUrl = media.storageUrl || storageUrl;
    thumbnailUrl = media.thumbnailUrl || thumbnailUrl;
  } else if (thumbnailUrl) {
    thumbnailUrl = await uploadRemoteThumbnail(thumbnailUrl);
  }

  const validation = validateVideoPlaybackSource({
    streamUrl: storageUrl,
    embedUrl: row.embed_url,
    videoUrl: storageUrl || row.embed_url,
    thumbnailUrl,
    source: 'import',
  });
  const playbackUrl = validation.playbackUrl || null;
  const isEmbedPlayback = validation.embedAllowed || validation.sourceType === 'official_embed';
  const resolvedStreamUrl = isEmbedPlayback ? null : (storageUrl || playbackUrl || null);
  const resolvedEmbedUrl = isEmbedPlayback ? playbackUrl : (row.embed_url || null);

  if (![storageUrl, resolvedStreamUrl, resolvedEmbedUrl, playbackUrl].some((value) => cleanPayloadText(value))) {
    return { skipped: true, reason: 'missing_playback_source' };
  }

  const requestedCreatorId = row.creator_id || job.metadata?.creatorId || null;
  const importedAccessType = ['premium', 'members_only', 'coin_unlock', 'free'].includes(String(row.access_type || '').toLowerCase())
    ? String(row.access_type).toLowerCase()
    : (importType === 'premium' || row.is_premium_content ? 'premium' : 'free');
  const normalizedImportedAccessType = importedAccessType === 'members_only' ? 'coin_unlock' : importedAccessType;
  const tokenPrice = Math.max(0, parseInt(String(row.token_price || 0), 10) || 0);

  const baseRow = await applyOfficialCompanyOwnership({
    video_id: videoId,
    title: row.title,
    description: row.description,
    tags: row.tags,
    main_orientation_category: row.main_orientation_category,
    storage_url: storageUrl,
    stream_url: resolvedStreamUrl,
    embed_url: resolvedEmbedUrl,
    thumbnail_url: thumbnailUrl,
    duration_seconds: row.duration_seconds,
    is_premium_content: importType === 'premium' || row.is_premium_content === true || normalizedImportedAccessType !== 'free',
    token_price: normalizedImportedAccessType === 'coin_unlock' || tokenPrice > 0 ? tokenPrice : 0,
    coin_price: normalizedImportedAccessType === 'coin_unlock' || tokenPrice > 0 ? tokenPrice : 0,
    access_type: normalizedImportedAccessType,
    requires_membership: false,
    subscription_access: false,
    premium_visibility: row.premium_visibility || (normalizedImportedAccessType === 'free' ? 'public' : 'public_preview'),
    is_live: true,
    status: 'published',
    visibility: 'public',
    import_job_id: job.id,
    external_id: row.external_id,
    provider: row.provider,
    import_hash: importHash,
    metadata: sanitizePersistedMetadata(row.metadata),
    playable: validation.playable,
    source_type: validation.sourceType,
    embed_allowed: validation.embedAllowed,
    validation_status: validation.validationStatus,
    playback_url: playbackUrl,
    is_indexed: false,
  }, { source: importType === 'deleted_urls' ? 'imported' : 'official_import', originalCreatorId: requestedCreatorId });

  if (importType === 'deleted_urls') {
    return { skipped: true, reason: 'deleted_urls handled separately' };
  }

  return { payload: baseRow, videoId };
}

export async function importVideoRow({
  job,
  parsedRow,
  mediaDir,
  importType,
}) {
  const prepared = await prepareVideoImportPayload({
    job,
    parsedRow,
    mediaDir,
    importType,
  });
  if (prepared.skipped) return prepared;

  const result = await upsertVideoPayloadBatch([prepared.payload]);
  const indexedRow = result.data?.[0] || prepared.payload;
  try {
    await indexVideoRow(indexedRow);
  } catch (err) {
    await enqueueSearchIndex(prepared.videoId, 'upsert');
    console.warn('[import] index deferred:', err?.message);
  }
  invalidateTopCreatorsCache();
  return { ok: true, videoId: prepared.videoId, action: result.action };
}
