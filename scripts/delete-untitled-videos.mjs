/**
 * delete-untitled-videos.mjs
 * Deletes all videos with a blank or "Untitled" title from both
 * Firebase RTDB (videos/) and Supabase (tiktok_videos).
 *
 * Usage: node scripts/delete-untitled-videos.mjs
 *
 * Run from the backend/ directory so dotenv finds .env.
 */

import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import admin from 'firebase-admin';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Supabase ──────────────────────────────────────────────────────────────────
const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

let supabase = null;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey, { auth: { autoRefreshToken: false } });
  console.log('✅ Supabase client ready');
} else {
  console.warn('⚠️  Supabase not configured — skipping Supabase cleanup');
}

// ── Firebase Admin ────────────────────────────────────────────────────────────
let rtdb = null;
try {
  if (!admin.apps.length) {
    const serviceAccountPath =
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      path.resolve(__dirname, '../firebase-service-account.json');

    let credential;
    if (
      process.env.FIREBASE_SERVICE_ACCOUNT_KEY &&
      process.env.FIREBASE_SERVICE_ACCOUNT_KEY.trim().startsWith('{')
    ) {
      credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY));
    } else if (fs.existsSync(serviceAccountPath)) {
      credential = admin.credential.cert(serviceAccountPath);
    } else {
      console.warn('⚠️  Firebase credentials not found — skipping RTDB cleanup');
    }

    if (credential) {
      admin.initializeApp({
        credential,
        databaseURL: process.env.FIREBASE_DATABASE_URL,
      });
    }
  }
  if (admin.apps.length) {
    rtdb = admin.database();
    console.log('✅ Firebase RTDB ready');
  }
} catch (err) {
  console.warn('⚠️  Firebase init failed:', err.message, '— skipping RTDB cleanup');
}

function isUntitled(title) {
  if (!title) return true;
  return title.trim().toLowerCase() === 'untitled';
}

// ── Clean Supabase tiktok_videos ──────────────────────────────────────────────
async function cleanSupabase() {
  if (!supabase) return;
  console.log('\n📦 Checking Supabase tiktok_videos...');

  const { data, error } = await supabase
    .from('tiktok_videos')
    .select('video_id, title');

  if (error) {
    console.error('  Supabase fetch error:', error.message);
    return;
  }

  const toDelete = (data || []).filter(v => isUntitled(v.title)).map(v => v.video_id);
  console.log(`  Found ${toDelete.length} Untitled video(s) in tiktok_videos`);

  if (toDelete.length === 0) return;

  for (const id of toDelete) {
    const { error: delErr } = await supabase
      .from('tiktok_videos')
      .delete()
      .eq('video_id', id);
    if (delErr) {
      console.error(`  ❌ Failed to delete ${id}:`, delErr.message);
    } else {
      console.log(`  🗑  Deleted Supabase video: ${id}`);
    }
  }
}

// ── Clean Firebase RTDB videos/ ───────────────────────────────────────────────
async function cleanRtdb() {
  if (!rtdb) return;
  console.log('\n🔥 Checking Firebase RTDB videos/...');

  const snap = await rtdb.ref('videos').once('value');
  const val = snap.val();
  if (!val) { console.log('  No videos found in RTDB'); return; }

  const entries = Object.entries(val).filter(([, v]) => isUntitled(v?.title));
  console.log(`  Found ${entries.length} Untitled video(s) in RTDB`);

  for (const [id] of entries) {
    await rtdb.ref(`videos/${id}`).remove();
    console.log(`  🗑  Deleted RTDB video: ${id}`);
  }
}

// ── Run ───────────────────────────────────────────────────────────────────────
(async () => {
  await Promise.all([cleanSupabase(), cleanRtdb()]);
  console.log('\n✅ Done. All Untitled videos removed from both databases.');
  process.exit(0);
})().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
