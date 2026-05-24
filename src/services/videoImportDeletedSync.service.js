import { supabase } from '../config/supabase.js';
import { removeVideoFromIndex } from './searchIndex.service.js';

function normalizeUrl(url) {
  try {
    const u = new URL(String(url || '').trim());
    return `${u.origin}${u.pathname}`.toLowerCase();
  } catch {
    return String(url || '').trim().toLowerCase();
  }
}

export async function processDeletedUrlRow(jobId, rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) return { ok: false, reason: 'empty_url' };
  const normalized = normalizeUrl(url);

  if (supabase) {
    const { error: logError } = await supabase.from('video_import_deleted_urls').insert({
      job_id: jobId,
      url,
      normalized_url: normalized,
      processed_at: new Date().toISOString(),
    });
    if (logError) {
      console.warn('[video-import] deleted-url log failed:', logError.message || logError);
    }

    const { data: matches } = await supabase
      .from('tiktok_videos')
      .select('video_id, embed_url, playback_url, stream_url, storage_url')
      .or(`embed_url.ilike.%${url.slice(-80)}%,playback_url.ilike.%${url.slice(-80)}%`)
      .limit(50);

    for (const row of matches || []) {
      const candidates = [row.embed_url, row.playback_url, row.stream_url, row.storage_url].map(normalizeUrl);
      if (!candidates.includes(normalized)) continue;
      await supabase.from('tiktok_videos').update({
        deleted_at: new Date().toISOString(),
        is_live: false,
        status: 'removed',
      }).eq('video_id', row.video_id);
      await removeVideoFromIndex(row.video_id);
    }
  }

  return { ok: true, normalized };
}

export async function processDeletedUrlBatch(jobId, urls) {
  let ok = 0;
  let failed = 0;
  for (const url of urls) {
    try {
      const result = await processDeletedUrlRow(jobId, url);
      if (result.ok) ok += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { ok, failed };
}
