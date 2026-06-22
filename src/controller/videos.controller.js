import { getFirebaseRtdb } from '../config/firebase.js';
import { mergeCreatorIntoPublicVideo } from '../utils/creatorProfile.js';
import { supabase, isConfigured as isSupabaseConfigured } from '../config/supabase.js';
import { filterPlayableVideos } from '../utils/videoPlaybackValidation.js';

const USER_POSTS_LIMIT = Math.min(500, Math.max(25, Number(process.env.USER_POSTS_LIMIT || 250)));

function videosRef() {
  const rtdb = getFirebaseRtdb();
  return rtdb ? rtdb.ref('videos') : null;
}

function isMissingColumnError(err, columnName) {
  const msg = String(err?.message || '');
  return (
    err?.code === 'PGRST204' ||
    err?.code === '42703' ||
    (columnName && msg.includes(`'${columnName}'`)) ||
    /schema cache|Could not find the .* column|does not exist/i.test(msg)
  );
}

/**
 * GET /api/posts?userId=...
 * Owner (Bearer uid === userId) sees all videos including drafts.
 * Others only see published (isLive === true).
 * Consolidated to pull from both Firebase RTDB and Supabase tiktok_videos.
 */
export async function listPosts(req, res) {
  try {
    const userId = String(req.query.userId || '').trim();
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId required', data: [] });
    }
    const requesterUid = req.uid;
    const isOwner = Boolean(requesterUid && requesterUid === userId);

    // 1. Fetch from Firebase RTDB
    let rtdbList = [];
    if (videosRef()) {
      let snap = await videosRef()
        .orderByChild('userId')
        .equalTo(userId)
        .limitToLast(USER_POSTS_LIMIT)
        .once('value');
      let val = snap.val();
      if (!val) {
        snap = await videosRef()
          .orderByChild('user_id')
          .equalTo(userId)
          .limitToLast(USER_POSTS_LIMIT)
          .once('value');
        val = snap.val();
      }
      if (val && typeof val === 'object') {
        rtdbList = Object.entries(val)
          .map(([videoId, v]) => ({
            ...(typeof v === 'object' && v ? v : {}),
            videoId,
            id: videoId,
            source: 'rtdb'
          }))
          .filter((row) => row.userId === userId || row.user_id === userId);
      }
    }

    // 2. Fetch from Supabase tiktok_videos
    let supabaseList = [];
    if (isSupabaseConfigured() && supabase) {
      let q = supabase.from('tiktok_videos').select('*').eq('user_id', userId);
      if (!isOwner) q = q.eq('status', 'published');
      
      let { data, error } = await q.order('created_at', { ascending: false }).limit(USER_POSTS_LIMIT);
      if (error && !isOwner && isMissingColumnError(error, 'status')) {
        ({ data, error } = await supabase
          .from('tiktok_videos')
          .select('*')
          .eq('user_id', userId)
          .eq('is_live', true)
          .order('created_at', { ascending: false })
          .limit(USER_POSTS_LIMIT));
      }
      if (!error && data) {
        supabaseList = data.map(v => ({
          videoId: v.video_id,
          id: v.video_id,
          userId: v.user_id,
          title: v.title,
          description: v.description,
          videoUrl: v.storage_url,
          streamUrl: v.storage_url,
          thumbnailUrl: v.thumbnail_url,
          totalLikes: v.likes_count,
          totalComments: v.comments_count,
          createdAt: new Date(v.created_at).getTime(),
          isLive: v.is_live === true || v.status === 'published',
          isPremiumContent: v.coin_price > 0,
          tokenPrice: v.coin_price,
          source: 'supabase'
        }));
      }
    }

    if (!isOwner) {
      rtdbList = rtdbList.filter((row) => row.isLive === true);
    }

    // Merge and sort
    let list = [...rtdbList, ...supabaseList].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    let enriched = await Promise.all(list.map((row) => mergeCreatorIntoPublicVideo(row)));
    if (!isOwner) {
      enriched = filterPlayableVideos(enriched);
    }
    return res.json({ success: true, data: enriched });
  } catch (err) {
    console.error('posts.listPosts error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed', data: [] });
  }
}
