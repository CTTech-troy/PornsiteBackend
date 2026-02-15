if (typeof fetch === 'undefined') {
	try {
		const { default: fetchPoly } = await import('node-fetch');
		global.fetch = fetchPoly;
		console.log('Polyfilled global.fetch using node-fetch');
	} catch (err) {
		console.warn('node-fetch not available. Install with `npm i node-fetch` or run on Node 18+ to provide global fetch.');
	}
}


 
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY ;
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST ;


const VIDEO_API_HOSTS = (process.env.VIDEO_API_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
const VIDEO_API_KEYS = (process.env.VIDEO_API_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);

async function fetchJsonDetailed(url, options = {}) {
	const { retries = 1, timeout = 20000, method, headers, body } = options;
	console.log('Request URL:', url);
	console.log('Request options:', { method, headers });

	let attempt = 0;
	while (attempt < Math.max(1, retries)) {
		attempt += 1;
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeout);
		try {
			const res = await fetch(url, { method, headers, body, signal: controller.signal });
			clearTimeout(timeoutId);
			console.log('Response status:', res.status, res.statusText);
			const contentType = res.headers.get('content-type') || '';
			console.log('Response content-type:', contentType);

			let respBody;
			if (contentType.includes('application/json')) {
				respBody = await res.json();
				console.log('Response JSON body:', JSON.stringify(respBody, null, 2));
			} else {
				respBody = await res.text();
				console.log('Response text body:', respBody.slice(0, 2000));
			}

			return { status: res.status, headers: res.headers, body: respBody };
		} catch (err) {
			clearTimeout(timeoutId);
			console.error(`Fetch error (attempt ${attempt}):`, err && err.stack ? err.stack : err);
			const isAbort = err && (err.name === 'AbortError' || err.type === 'aborted' || err.code === 'UND_ERR_CONNECT_TIMEOUT');
			if (attempt >= retries) {
				throw err;
			}
			await new Promise(res => setTimeout(res, 500 * attempt));
		}
	}
	// Shouldn't reach here
	throw new Error('fetchJsonDetailed: exceeded retries');
}

/**
 * Normalize an array of external video items into the minimal shape
 * { title, thumbnail, video_url, duration }
 * Also logs the full list for debugging.
 */
export function normalizeExternalVideos(items) {
	try {
		console.log('normalizeExternalVideos - full upstream items:', JSON.stringify(items, null, 2));
	} catch (e) {
		console.warn('Failed to stringify upstream items for logging', e && e.message ? e.message : e);
	}
	if (!Array.isArray(items)) return [];

	// Helper to pick the first defined/non-empty value from multiple possible paths.
	const getFirst = (obj, paths) => {
		for (const p of paths) {
			if (!p) continue;
			const parts = p.split('.');
			let cur = obj;
			for (const part of parts) {
				if (cur == null) { cur = undefined; break; }
				cur = cur[part];
			}
			if (cur !== undefined && cur !== null && String(cur).trim() !== '') return cur;
		}
		return '';
	};

	return items.map((it) => {
		const title = getFirst(it, ['title', 'name', 'video_title', 'snippet.title']);
		const thumbnail = getFirst(it, ['thumbnail', 'thumbnail_url', 'preview', 'thumb', 'poster', 'thumbnails.0']);
		const video_url = getFirst(it, ['video_url', 'videoUrl', 'url', 'video']);
		const duration = getFirst(it, ['duration', 'length', 'duration_str']);
		return { title, thumbnail, video_url, duration };
	}).filter(v => v.thumbnail && v.video_url && v.title);
}

export async function downloadVideo(videoLink) {
	const host = VIDEO_API_HOSTS.length ? VIDEO_API_HOSTS[0] : RAPIDAPI_HOST;
	const key = VIDEO_API_KEYS.length ? VIDEO_API_KEYS[0] : RAPIDAPI_KEY;
	// Try common download paths: /api/download then /download
	const paths = ['/api/download', '/download'];
	for (const p of paths) {
		const url = `https://${host}${p}`;
		const options = {
			method: 'POST',
			headers: {
				'x-rapidapi-key': key,
				'x-rapidapi-host': host,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ url: videoLink, video_link: videoLink, link: videoLink })
		};
		try {
			console.log('\n-- downloadVideo call --', url);
			return await fetchJsonDetailed(url, options);
		} catch (e) {
			console.warn('download path failed, trying next', p, e && e.message ? e.message : e);
		}
	}
	throw new Error('All download endpoints failed');
}

export async function searchVideos(query) {
	const q = (typeof query === 'string') ? query : (query && query.q) || '';
	const pages = (typeof query === 'object' && query.pages) ? query.pages : undefined;
	const hostsList = VIDEO_API_HOSTS.length ? VIDEO_API_HOSTS : (RAPIDAPI_HOST ? [RAPIDAPI_HOST] : []);
	const keysList = VIDEO_API_KEYS.length ? VIDEO_API_KEYS : (RAPIDAPI_KEY ? [RAPIDAPI_KEY] : []);
	if (!hostsList.length || !keysList.length) {
		return { status: 400, body: { error: 'No video API hosts configured (set VIDEO_API_HOSTS/VIDEO_API_KEYS or RAPIDAPI_HOST/RAPIDAPI_KEY)' } };
	}
	if (hostsList.length > 1) {
		console.log('\n-- searchVideos aggregated call to hosts --', hostsList);
		const promises = hostsList.map((host, i) => {
			const key = keysList[i] || keysList[0] || RAPIDAPI_KEY;
			const paths = ['/api/search', '/search'];
			const methods = ['POST', 'GET'];
			const trySearch = async () => {
				for (const p of paths) {
					for (const method of methods) {
						let url = `https://${host}${p}`;
						let body = pages ? JSON.stringify({ q, pages }) : JSON.stringify({ q });
						let options;
						if (method === 'GET') {
							url = `${url}?q=${encodeURIComponent(q)}${pages ? `&pages=${encodeURIComponent(pages)}` : ''}`;
							options = { method: 'GET', headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': host } };
						} else {
							options = { method: 'POST', headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': host, 'Content-Type': 'application/json' }, body };
						}
						try {
							const r = await fetchJsonDetailed(url, options);
							return { host, method, path: p, result: r };
						} catch (e) {
							console.warn('search attempt failed for', { host, path: p, method, err: e && e.message ? e.message : e });
						}
					}
				}
				return { host, error: 'No search paths/methods succeeded for host ' + host };
			};
			return trySearch().catch(err => ({ host, error: err && err.message ? err.message : String(err) }));
		});
		const results = await Promise.all(promises);
		return { status: 200, body: results };
	}

	const host = hostsList[0];
	const key = keysList[0];
	const paths = ['/api/search', '/search'];
	const methods = ['POST', 'GET'];
	for (const p of paths) {
		for (const method of methods) {
			let url = `https://${host}${p}`;
			let options;
			if (method === 'GET') {
				url = `${url}?q=${encodeURIComponent(q)}${pages ? `&pages=${encodeURIComponent(pages)}` : ''}`;
				options = { method: 'GET', headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': host } };
			} else {
				const body = pages ? JSON.stringify({ q, pages }) : JSON.stringify({ q });
				options = { method: 'POST', headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': host, 'Content-Type': 'application/json' }, body };
			}
			try {
				console.log('\n-- searchVideos call --', { url, method });
				return await fetchJsonDetailed(url, options);
			} catch (e) {
				console.warn('search attempt failed, trying next', { path: p, method, err: e && e.message ? e.message : e });
			}
		}
	}
	return { status: 502, body: { error: 'All search endpoints failed for host ' + host } };
}

export async function getTrending(page = 1) {
	const hosts = VIDEO_API_HOSTS.length ? VIDEO_API_HOSTS : (RAPIDAPI_HOST ? [RAPIDAPI_HOST] : []);
	const keys = VIDEO_API_KEYS.length ? VIDEO_API_KEYS : (RAPIDAPI_KEY ? [RAPIDAPI_KEY] : []);
	const results = [];
	for (let i = 0; i < hosts.length; i++) {
		const host = hosts[i];
		const key = keys[i] || keys[0] || RAPIDAPI_KEY;
		const paths = ['/api/trending', '/trending'];
		for (const p of paths) {
			const url = `https://${host}${p}?page=${encodeURIComponent(page)}`;
			try {
				const r = await fetchJsonDetailed(url, { method: 'GET', headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': host } });
				results.push({ host, result: r });
				break;
			} catch (e) {
				console.warn('trending path failed for host', host, p, e && e.message ? e.message : e);
			}
		}
	}
	return { status: 200, body: results };
}

/**
 * Fetch categories list from RapidAPI Pornhub API
 */
export async function getCategories() {
	const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
	const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'pornhub-api1.p.rapidapi.com';
	if (!RAPIDAPI_KEY) throw new Error('Missing RAPIDAPI_KEY on server');
	const url = `https://${RAPIDAPI_HOST}/categories_list/en`;
	const resp = await fetchJsonDetailed(url, { method: 'GET', headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': RAPIDAPI_HOST } });
	// resp.body may be array or object
	const data = resp.body;
	if (Array.isArray(data)) return data;
	if (data && Array.isArray(data.data)) return data.data;
	// fallback: try keys
	return [];
}

/**
 * Fetch user profile by nickname (generic user)
 */
export async function getUserByNickname(nickname) {
	const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
	const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'pornhub-api1.p.rapidapi.com';
	if (!RAPIDAPI_KEY) throw new Error('Missing RAPIDAPI_KEY on server');
	const url = `https://${RAPIDAPI_HOST}/users/${encodeURIComponent(nickname)}`;
	const resp = await fetchJsonDetailed(url, { method: 'GET', headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': RAPIDAPI_HOST } });
	return resp.body;
}

/**
 * Fetch pornstar profile by nickname and map to frontend-friendly shape
 */
export async function getPornstarByNickname(nickname) {
	const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
	const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'pornhub-api1.p.rapidapi.com';
	if (!RAPIDAPI_KEY) throw new Error('Missing RAPIDAPI_KEY on server');
	const url = `https://${RAPIDAPI_HOST}/pornstars/${encodeURIComponent(nickname)}`;
	const resp = await fetchJsonDetailed(url, { method: 'GET', headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': RAPIDAPI_HOST } });
	const src = resp.body || {};
	// Map fields to the sample shape requested by frontend
	const mapped = {
		about_text: src.about_text ?? src.about || null,
		avatar: src.avatar || src.avatar_url || src.image || null,
		biography: {
			birth_place: src.biography?.birth_place || src.birth_place || null,
			ethnicity: src.biography?.ethnicity || null,
			fake_boobs: src.biography?.fake_boobs || null,
			gender: src.biography?.gender || null,
			hair_color: src.biography?.hair_color || src.hair_color || null,
			height: src.biography?.height || src.height || null,
			interested_in: src.biography?.interested_in || null,
			piercings: src.biography?.piercings || null,
			relationship_status: src.biography?.relationship_status || null,
			tattoos: src.biography?.tattoos || null,
			turn_ons: src.biography?.turn_ons || null,
			videos_watched: src.biography?.videos_watched || null,
			weight: src.biography?.weight || null,
		},
		header: src.header || src.header_url || src.cover || null,
		id: src.id || src.user_id || null,
		is_verified: !!(src.is_verified || src.verified),
		name: src.name || src.full_name || src.display_name || src.username || nickname,
		ranks: src.ranks || {},
		recent_videos: Array.isArray(src.recent_videos) ? src.recent_videos.map(v => ({
			duration: v.duration || v.length || '',
			image: v.image || v.thumbnail || v.preview || '',
			title: v.title || v.name || '',
			url: v.url || v.video_url || v.link || '',
			views: v.views || v.view_count || '0'
		})) : [],
		social_links: src.social_links || src.social || {},
		subscribers_count: src.subscribers_count || src.subscribers || src.subscriber_count || 0,
		username: src.username || src.slug || nickname,
		video_count: src.video_count || src.videos || 0,
		video_views: src.video_views || src.views || 0,
		raw: src,
	};
	return mapped;
}

/**
 * Fetch channel by slug
 */
export async function getChannelBySlug(slug) {
	const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
	const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'pornhub-api1.p.rapidapi.com';
	if (!RAPIDAPI_KEY) throw new Error('Missing RAPIDAPI_KEY on server');
	const url = `https://${RAPIDAPI_HOST}/channels/${encodeURIComponent(slug)}`;
	const resp = await fetchJsonDetailed(url, { method: 'GET', headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': RAPIDAPI_HOST } });
	return resp.body;
}

import { fileURLToPath } from 'url';

// If run directly (node ./src/controller/videos.controller.js), run a sample search.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	(async () => {
		try {
			await searchVideos('Sister hot');
			await downloadVideo('https://xnxx.com/video-igzp72a/hot_girl');
			try {
				const url = 'https://pornhub-api-xnxx.p.rapidapi.com/api/trending?page=1';
				const options = {
					method: 'GET',
					headers: {
						'x-rapidapi-key': process.env.RAPIDAPI_KEY || '',
						'x-rapidapi-host': process.env.RAPIDAPI_HOST || ''
					}
				};
				const r = await fetchJsonDetailed(url, { ...options, retries: 2, timeout: 15000 });
				console.log('Sample trending response:', r.status);
			} catch (err) {
				console.error('Sample trending fetch failed (ignored):', err && err.stack ? err.stack : err);
			}
		} catch (err) {
			console.error('Error in sample run:', err && err.stack ? err.stack : err);
		}
	})();
}

