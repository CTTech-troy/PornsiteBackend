/**
 * Creators: list (from pornstars API, sorted by rankingScore) and detail (from scraper API).
 * Fallback: pornhub-api-xnxx search when scraper returns 429 or fails.
 */
import { fetchPornstars } from './star.controller.js';
import { xnxxSearch } from './xnxxSearchFallback.js';

const SCRAPER_CACHE = new Map();
const SCRAPER_CACHE_TTL = 10 * 60 * 1000; // 10 min

function slugify(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'creator';
}

/** Extract model slug from Pornhub model URL or link. */
function slugFromLink(link) {
  if (!link || typeof link !== 'string') return '';
  const m = link.match(/\/model\/([^/?]+)/i);
  return m ? m[1] : '';
}

/**
 * GET list: use pornstars API, add id/slug and rankingScore, sort descending.
 */
export async function getCreatorsList(req, res) {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10) || 100, 1), 500);
    const raw = await fetchPornstars(limit);
    const list = (Array.isArray(raw) ? raw : []).map((s, index) => {
      const name = s.star_name || s.name || '';
      const link = s.link || s.url || s.profile_url || '';
      const slug = slugFromLink(link) || slugify(name) || `c-${index}`;
      const rankingScore = Number(s.ranking_score ?? s.videos_count_all ?? s.views ?? s.rank ?? 0) || 0;
      return {
        id: slug,
        slug,
        name,
        star_name: name,
        avatar: s.star_thumb || s.thumb || s.avatar || '',
        videosCount: Number(s.videos_count_all ?? s.videos_count ?? 0) || 0,
        rankingScore,
        link: link || `https://www.pornhub.com/model/${slug}/videos`,
      };
    });
    list.sort((a, b) => (b.rankingScore || 0) - (a.rankingScore || 0));
    return res.json({ success: true, data: list });
  } catch (err) {
    console.error('creators.getCreatorsList', err?.message || err);
    return res.status(500).json({ success: false, data: [], message: err?.message || 'Failed' });
  }
}

/** Slug to search query: "abella-danger" -> "abella danger" */
function slugToQuery(slug) {
  if (!slug || typeof slug !== 'string') return '';
  return slug.replace(/-/g, ' ').trim() || slug;
}

function mapXnxxVideoToCreatorVideo(v, i) {
  const thumb = v.thumb ?? v.thumbnail ?? v.thumbnailUrl ?? v.poster ?? v.thumb_url ?? (v.thumbs && v.thumbs[0]?.src) ?? '';
  const thumbStr = typeof thumb === 'string' ? thumb : (thumb?.src ?? thumb?.url ?? '');
  return {
    id: v.video_id ?? v.id ?? v.key ?? v.url ?? `v-${i}`,
    title: v.title || v.title_clean || v.name || 'Video',
    thumbnail: thumbStr,
    duration: v.duration ?? v.length ?? 0,
    views: v.views ?? v.views_count ?? 0,
    url: v.url ?? v.video_url ?? v.link ?? '',
  };
}

/**
 * GET creator by slug: fetch profile + videos from scraper API.
 * On 429 or failure: use pornhub-api-xnxx search with slug as query and return synthetic profile.
 */
export async function getCreatorBySlug(req, res) {
  const slug = (req.params.slug || '').trim();
  if (!slug) return res.status(400).json({ success: false, error: 'Creator slug required' });

  const cacheKey = `slug:${slug}`;
  const cached = SCRAPER_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < SCRAPER_CACHE_TTL) {
    return res.json({ success: true, data: cached.data });
  }

  const key = process.env.RAPIDAPI_SCRAPER_KEY;
  const host = process.env.RAPIDAPI_SCRAPER_HOST;
  const baseUrl = process.env.RAPIDAPI_SCRAPER_URL || `https://${host}/api/pornhub/pornstar`;
  const apiKey = process.env.RAPIDAPI_SCRAPER_API_KEY;

  if (!key || !host) {
    return res.status(503).json({ success: false, error: 'Scraper API not configured' });
  }

  const modelUrl = `https://www.pornhub.com/model/${encodeURIComponent(slug)}/videos`;
  const url = `${baseUrl}?url=${encodeURIComponent(modelUrl)}&page=1`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const headers = {
      'x-rapidapi-key': key,
      'x-rapidapi-host': host,
      'Content-Type': 'application/json',
    };
    if (apiKey) headers['x-api-key'] = apiKey;

    const resFetch = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    clearTimeout(timeoutId);

    if (!resFetch.ok) {
      if (resFetch.status === 429) {
        if (cached && cached.data) {
          return res.status(200).json({ success: true, data: cached.data, _cached: true, _rateLimited: true });
        }
        const fallbackVideos = await xnxxSearch(slugToQuery(slug), 1);
        if (fallbackVideos.length > 0) {
          const displayName = slugToQuery(slug).replace(/\b\w/g, (c) => c.toUpperCase());
          const data = {
            id: slug,
            slug,
            name: displayName,
            avatar: '',
            bio: '',
            videosCount: fallbackVideos.length,
            videos: fallbackVideos.map(mapXnxxVideoToCreatorVideo),
            _fallback: 'xnxx-search',
          };
          SCRAPER_CACHE.set(cacheKey, { ts: Date.now(), data });
          return res.status(200).json({ success: true, data });
        }
        return res.status(429).json({ success: false, error: 'Rate limit exceeded' });
      }
      const fallbackVideos = await xnxxSearch(slugToQuery(slug), 1);
      if (fallbackVideos.length > 0) {
        const displayName = slugToQuery(slug).replace(/\b\w/g, (c) => c.toUpperCase());
        const data = {
          id: slug,
          slug,
          name: displayName,
          avatar: '',
          bio: '',
          videosCount: fallbackVideos.length,
          videos: fallbackVideos.map(mapXnxxVideoToCreatorVideo),
          _fallback: 'xnxx-search',
        };
        SCRAPER_CACHE.set(cacheKey, { ts: Date.now(), data });
        return res.status(200).json({ success: true, data });
      }
      return res.status(resFetch.status).json({ success: false, error: 'Scraper request failed' });
    }

    const json = await resFetch.json();
    const profile = json.profile || json.data?.profile || json.model || json.data?.model || {};
    const videosRaw = json.videos ?? json.data?.videos ?? json.results ?? [];
    const videos = Array.isArray(videosRaw) ? videosRaw : [];

    const data = {
      id: slug,
      slug,
      name: profile.name || profile.star_name || profile.username || slug,
      avatar: profile.avatar || profile.star_thumb || profile.thumb || profile.image || '',
      bio: profile.bio || profile.description || '',
      videosCount: profile.videos_count ?? profile.videosCount ?? videos.length,
      videos: videos.map((v, i) => ({
        id: v.id || v.video_id || v.key || `v-${i}`,
        title: v.title || v.name || '',
        thumbnail: v.thumbnail || v.thumb || v.poster || '',
        duration: v.duration ?? v.length ?? 0,
        views: v.views ?? v.views_count ?? 0,
        url: v.url || v.link || '',
      })),
    };

    SCRAPER_CACHE.set(cacheKey, { ts: Date.now(), data });
    return res.json({ success: true, data });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err?.name === 'AbortError') {
      const fallbackVideos = await xnxxSearch(slugToQuery(slug), 1);
      if (fallbackVideos.length > 0) {
        const displayName = slugToQuery(slug).replace(/\b\w/g, (c) => c.toUpperCase());
        const data = {
          id: slug,
          slug,
          name: displayName,
          avatar: '',
          bio: '',
          videosCount: fallbackVideos.length,
          videos: fallbackVideos.map(mapXnxxVideoToCreatorVideo),
          _fallback: 'xnxx-search',
        };
        return res.status(200).json({ success: true, data });
      }
      return res.status(504).json({ success: false, error: 'Scraper timeout' });
    }
    const fallbackVideos = await xnxxSearch(slugToQuery(slug), 1).catch(() => []);
    if (fallbackVideos.length > 0) {
      const displayName = slugToQuery(slug).replace(/\b\w/g, (c) => c.toUpperCase());
      const data = {
        id: slug,
        slug,
        name: displayName,
        avatar: '',
        bio: '',
        videosCount: fallbackVideos.length,
        videos: fallbackVideos.map(mapXnxxVideoToCreatorVideo),
        _fallback: 'xnxx-search',
      };
      return res.status(200).json({ success: true, data });
    }
    console.error('creators.getCreatorBySlug', err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || 'Failed' });
  }
}
import { supabase, isConfigured } from '../config/supabase.js';
import { getFirebaseRtdb } from '../config/firebase.js';

// Creator management + wallet helpers

async function getCreator(userId) {
	if (!isConfigured()) throw new Error('Supabase not configured');
	const { data, error } = await supabase.from('creators').select('*').eq('user_id', userId).maybeSingle();
	if (error) throw error;
	return data;
}

async function upsertCreator(userId, profile) {
	if (!isConfigured()) throw new Error('Supabase not configured');
	const payload = { user_id: userId, ...profile };
	const { data, error } = await supabase.from('creators').upsert(payload, { onConflict: 'user_id' }).select().maybeSingle();
	if (error) throw error;
	return data;
}

async function getWallet(ownerId) {
	if (!isConfigured()) throw new Error('Supabase not configured');
	const { data, error } = await supabase.from('wallets').select('*').eq('owner_id', ownerId).maybeSingle();
	if (error) throw error;
	return data || { owner_id: ownerId, balance: 0 };
}

async function incrementWallet(ownerId, amount) {
	if (!isConfigured()) throw new Error('Supabase not configured');
	// Try RPC if exists
	try {
		const rpcName = 'increment_wallet_balance';
		// RPC signature: (p_owner_id text, p_amount numeric)
		const { data, error } = await supabase.rpc(rpcName, { p_owner_id: ownerId, p_amount: Number(amount) });
		if (error) throw error;
		return data;
	} catch (rpcErr) {
		// Fallback to upsert/update
		const { data: existing, error: exErr } = await supabase.from('wallets').select('*').eq('owner_id', ownerId).maybeSingle();
		if (exErr) throw exErr;
		if (existing) {
			const newBal = Number(existing.balance || 0) + Number(amount || 0);
			const { data, error } = await supabase.from('wallets').update({ balance: newBal, updated_at: new Date().toISOString() }).eq('owner_id', ownerId).select().maybeSingle();
			if (error) throw error;
			return data;
		}
		const { data, error } = await supabase.from('wallets').insert([{ owner_id: ownerId, balance: Number(amount || 0) }]).select().maybeSingle();
		if (error) throw error;
		return data;
	}
}

async function debitWallet(ownerId, amount) {
	if (!isConfigured()) throw new Error('Supabase not configured');
	const { data: w, error: wErr } = await supabase.from('wallets').select('*').eq('owner_id', ownerId).maybeSingle();
	if (wErr) throw wErr;
	const balance = Number(w?.balance || 0);
	const amt = Number(amount || 0);
	if (balance < amt) throw new Error('Insufficient wallet balance');
	const newBal = +(balance - amt).toFixed(2);
	const { data, error } = await supabase.from('wallets').update({ balance: newBal, updated_at: new Date().toISOString() }).eq('owner_id', ownerId).select().maybeSingle();
	if (error) throw error;
	return data;
}

// Compute total earnings for a creator by summing live_gifts for lives owned by host
async function computeEarningsForHost(hostId) {
	if (!isConfigured()) throw new Error('Supabase not configured');
	// fetch lives for host
	const { data: lives, error: livesErr } = await supabase.from('lives').select('id').eq('host_id', hostId);
	if (livesErr) throw livesErr;
	const liveIds = (lives || []).map(l => l.id).filter(Boolean);
	if (!liveIds.length) return { total: 0, companyShare: 0, hostShare: 0 };
	const { data: gifts, error: giftsErr } = await supabase.from('live_gifts').select('amount').in('live_id', liveIds);
	if (giftsErr) throw giftsErr;
	const total = (gifts || []).reduce((s, g) => s + Number(g.amount || 0), 0);
	const companyShare = +(total * 0.3).toFixed(2);
	const hostShare = +(total * 0.7).toFixed(2);
	return { total, companyShare, hostShare };
}

// Fetch all platform creators filtered by type ('channel' | 'pstar').
async function getCreatorsByType(type, limit = 100) {
	if (!isConfigured()) throw new Error('Supabase not configured');
	const safeType = type === 'channel' ? 'channel' : 'pstar';
	const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
	const { data, error } = await supabase
		.from('creators')
		.select('user_id, display_name, bio, creator_type, created_at')
		.eq('creator_type', safeType)
		.order('created_at', { ascending: false })
		.limit(safeLimit);
	if (error) throw error;
	return data || [];
}

async function getTopPlatformCreators(limit = 5) {
	if (!isConfigured()) throw new Error('Supabase not configured');

	const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 20);

	const { data: creators, error } = await supabase
		.from('creators')
		.select('user_id, display_name')
		.limit(100);
	if (error) throw error;
	if (!creators || !creators.length) return [];

	// Count each creator's uploaded videos
	const withCounts = await Promise.all(
		creators.map(async (c) => {
			const { count } = await supabase
				.from('media')
				.select('id', { count: 'exact', head: true })
				.eq('user_id', c.user_id);
			return { ...c, videoCount: count || 0 };
		})
	);

	const top = withCounts
		.sort((a, b) => b.videoCount - a.videoCount)
		.slice(0, safeLimit);

	// Fetch profile pictures from Firebase RTDB
	const rtdb = getFirebaseRtdb();
	const result = await Promise.all(
		top.map(async (c) => {
			let avatar = null;
			if (rtdb) {
				try {
					const snap = await rtdb.ref(`users/${c.user_id}`).once('value');
					const val = snap.val();
					avatar = val?.avatar || val?.photoURL || null;
				} catch { /* no avatar — use null, frontend will fall back to dicebear */ }
			}
			return {
				id: c.user_id,
				name: c.display_name || 'Creator',
				avatar,
				videoCount: c.videoCount,
			};
		})
	);

	return result;
}

export {
	getCreator,
	upsertCreator,
	getCreatorsByType,
	getTopPlatformCreators,
	getWallet,
	incrementWallet,
	debitWallet,
	computeEarningsForHost
};
