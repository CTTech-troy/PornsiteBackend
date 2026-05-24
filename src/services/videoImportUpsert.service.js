import { randomUUID } from 'crypto';
import { supabase } from '../config/supabase.js';
import { validateVideoPlaybackSource } from '../utils/videoPlaybackValidation.js';
import { computeImportHash } from './videoImport.service.js';
import { resolveMediaUrls, uploadRemoteThumbnail } from './videoImportMedia.service.js';
import { indexVideoRow, enqueueSearchIndex } from './searchIndex.service.js';
import { invalidateTopCreatorsCache } from './creatorLeaderboard.service.js';
import { applyOfficialCompanyOwnership } from './officialCompany.service.js';

function isMissingColumn(err) {
  return err?.code === 'PGRST204' || err?.code === '42703' || /schema cache/i.test(String(err?.message || ''));
}

async function upsertVideoRow(row) {
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

export async function importVideoRow({
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

  const requestedCreatorId = row.creator_id || job.metadata?.creatorId || null;
  const importedAccessType = ['premium', 'members_only', 'coin_unlock', 'free'].includes(String(row.access_type || '').toLowerCase())
    ? String(row.access_type).toLowerCase()
    : (importType === 'premium' || row.is_premium_content ? 'premium' : 'free');
  const tokenPrice = Math.max(0, parseInt(String(row.token_price || 0), 10) || 0);

  const baseRow = await applyOfficialCompanyOwnership({
    video_id: videoId,
    title: row.title,
    description: row.description,
    tags: row.tags,
    main_orientation_category: row.main_orientation_category,
    storage_url: storageUrl,
    stream_url: storageUrl || validation.playbackUrl || null,
    embed_url: row.embed_url || null,
    thumbnail_url: thumbnailUrl,
    duration_seconds: row.duration_seconds,
    is_premium_content: importType === 'premium' || row.is_premium_content === true || importedAccessType !== 'free',
    token_price: importedAccessType === 'coin_unlock' || tokenPrice > 0 ? tokenPrice : 0,
    coin_price: importedAccessType === 'coin_unlock' || tokenPrice > 0 ? tokenPrice : 0,
    access_type: importedAccessType,
    requires_membership: importedAccessType === 'members_only' || row.requires_membership === true,
    subscription_access: row.subscription_access === true || importedAccessType === 'members_only',
    premium_visibility: row.premium_visibility || (importedAccessType === 'free' ? 'public' : 'public_preview'),
    is_live: true,
    status: 'published',
    visibility: 'public',
    import_job_id: job.id,
    external_id: row.external_id,
    provider: row.provider,
    import_hash: importHash,
    metadata: row.metadata,
    playable: validation.playable,
    source_type: validation.sourceType,
    embed_allowed: validation.embedAllowed,
    validation_status: validation.validationStatus,
    playback_url: validation.playbackUrl,
    is_indexed: false,
  }, { source: importType === 'deleted_urls' ? 'imported' : 'official_import', originalCreatorId: requestedCreatorId });

  if (importType === 'deleted_urls') {
    return { skipped: true, reason: 'deleted_urls handled separately' };
  }

  const result = await upsertVideoRow(baseRow);
  try {
    await indexVideoRow(result.data);
  } catch (err) {
    await enqueueSearchIndex(videoId, 'upsert');
    console.warn('[import] index deferred:', err?.message);
  }
  invalidateTopCreatorsCache();
  return { ok: true, videoId, action: result.action };
}
