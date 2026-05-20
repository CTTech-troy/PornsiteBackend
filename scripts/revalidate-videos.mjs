import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { getFirebaseRtdb } from '../src/config/firebase.js';
import { validateVideoPlaybackSource } from '../src/utils/videoPlaybackValidation.js';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const dryRun = process.argv.includes('--dry-run');

if (!supabaseUrl || !supabaseKey) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function revalidateSupabase() {
  const { data: rows, error } = await supabase
    .from('tiktok_videos')
    .select('video_id, storage_url, stream_url, embed_url');
  if (error) throw error;

  let updated = 0;
  let unsupported = 0;

  for (const row of rows || []) {
    const validation = validateVideoPlaybackSource({
      source: 'community',
      streamUrl: row.stream_url || row.storage_url,
      storage_url: row.storage_url,
      videoUrl: row.storage_url,
      embedUrl: row.embed_url,
    });
    if (!validation.playable) unsupported += 1;
    if (dryRun) {
      console.log(row.video_id, validation.validationStatus, validation.sourceType);
      continue;
    }
    const { error: upErr } = await supabase
      .from('tiktok_videos')
      .update({
        playable: validation.playable,
        source_type: validation.sourceType,
        embed_allowed: validation.embedAllowed,
        validation_status: validation.validationStatus,
        playback_url: validation.playbackUrl || null,
        ...(validation.playable ? {} : { status: 'removed' }),
      })
      .eq('video_id', row.video_id);
    if (!upErr) updated += 1;
  }

  return { scanned: (rows || []).length, updated, unsupported };
}

async function revalidateRtdb() {
  const rtdb = getFirebaseRtdb();
  if (!rtdb) return { scanned: 0, unsupported: 0 };

  const snap = await rtdb.ref('videos').once('value');
  const val = snap.val();
  if (!val) return { scanned: 0, unsupported: 0 };

  let scanned = 0;
  let unsupported = 0;

  for (const [id, v] of Object.entries(val)) {
    scanned += 1;
    const validation = validateVideoPlaybackSource({
      streamUrl: v.videoUrl || v.streamUrl,
      videoUrl: v.videoUrl || v.streamUrl,
      source: 'rtdb',
    });
    if (!validation.playable) {
      unsupported += 1;
      if (!dryRun) {
        await rtdb.ref(`videos/${id}`).update({ isLive: false });
      }
    }
  }

  return { scanned, unsupported };
}

async function main() {
  const supabaseResult = await revalidateSupabase();
  const rtdbResult = await revalidateRtdb();
  console.log(JSON.stringify({ dryRun, supabase: supabaseResult, rtdb: rtdbResult }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
