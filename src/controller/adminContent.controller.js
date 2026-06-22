import { supabase } from '../config/supabase.js';
import { getFirebaseRtdb } from '../config/firebase.js';
import { buildAdminUserFacetsByIds } from '../services/userDirectoryService.js';
import { validateVideoPlaybackSource } from '../utils/videoPlaybackValidation.js';
import { logAction as writeAuditAction } from '../services/adminAudit.service.js';
import { invalidateTopCreatorsCache } from '../services/creatorLeaderboard.service.js';
import { enqueueSearchIndex } from '../services/searchIndex.service.js';

const ADMIN_CONTENT_SOURCE_SCAN_LIMIT = Math.min(5000, Math.max(250, Number(process.env.ADMIN_CONTENT_SOURCE_SCAN_LIMIT || 1500)));

function invalidateCreatorLeaderboard() {
  try {
    invalidateTopCreatorsCache();
  } catch (_) {}
}

function paginate(page, limit) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  return { page: p, limit: l, offset: (p - 1) * l };
}

function isMissingTable(err) {
  return err?.code === '42P01' || err?.code === 'PGRST200' ||
    (typeof err?.message === 'string' && err.message.includes('schema cache'));
}

function isMissingColumn(err) {
  return err?.code === '42703' || err?.code === 'PGRST204';
}

function extractMissingColumnName(err) {
  const msg = String(err?.message || '');
  const quoted = msg.match(/'([^']+)'/);
  if (quoted?.[1]) return quoted[1];
  const named = msg.match(/column\s+["']?([a-zA-Z0-9_]+)["']?/i);
  if (named?.[1]) return named[1];
  return null;
}

const ACCESS_TYPES = new Set(['free', 'premium', 'coin_unlock']);
const PREMIUM_VISIBILITY = new Set(['public', 'public_preview', 'hidden']);

function normalizeBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeAccessType(value, fallback = 'free') {
  const normalized = String(value || '').trim().toLowerCase().replace(/-/g, '_');
  if (normalized === 'members_only') return 'coin_unlock';
  return ACCESS_TYPES.has(normalized) ? normalized : fallback;
}

function normalizePremiumPayload(body = {}) {
  let accessType = normalizeAccessType(body.accessType ?? body.access_type, '');
  const tokenPrice = Math.max(0, Math.floor(Number(body.tokenPrice ?? body.token_price ?? body.coinPrice ?? body.coin_price ?? body.price ?? 0) || 0));

  if (!accessType) {
    if (normalizeBool(body.isPremiumContent ?? body.is_premium_content ?? body.premium, false)) {
      accessType = tokenPrice > 0 ? 'coin_unlock' : 'premium';
    } else {
      accessType = 'free';
    }
  }

  let premiumVisibility = String(body.premiumVisibility ?? body.premium_visibility ?? '').trim().toLowerCase().replace(/-/g, '_');
  if (premiumVisibility === 'members_only') premiumVisibility = 'public_preview';
  if (!PREMIUM_VISIBILITY.has(premiumVisibility)) {
    premiumVisibility = accessType === 'free' ? 'public' : 'public_preview';
  }

  if (accessType === 'free') {
    premiumVisibility = 'public';
  }

  if (accessType === 'coin_unlock' && tokenPrice <= 0) {
    const err = new Error('Coin-unlock videos require a coin price greater than 0.');
    err.statusCode = 400;
    throw err;
  }

  const isPremiumContent =
    accessType !== 'free' ||
    tokenPrice > 0;

  return {
    accessType,
    isPremiumContent,
    tokenPrice: accessType === 'free' ? 0 : tokenPrice,
    requiresMembership: false,
    subscriptionAccess: false,
    premiumVisibility,
  };
}

function premiumUpdateForSupabase(payload) {
  return {
    is_premium_content: payload.isPremiumContent,
    token_price: payload.tokenPrice,
    coin_price: payload.tokenPrice,
    access_type: payload.accessType,
    requires_membership: payload.requiresMembership,
    subscription_access: payload.subscriptionAccess,
    premium_visibility: payload.premiumVisibility,
  };
}

function premiumUpdateForRtdb(payload) {
  return {
    isPremiumContent: payload.isPremiumContent,
    tokenPrice: payload.tokenPrice,
    coinPrice: payload.tokenPrice,
    accessType: payload.accessType,
    requiresMembership: payload.requiresMembership,
    subscriptionAccess: payload.subscriptionAccess,
    premiumVisibility: payload.premiumVisibility,
  };
}

async function logAction(adminId, adminName, action, targetType, targetId, details = {}) {
  await writeAuditAction(adminId, adminName, action, targetType, targetId, details);
}

function cleanAdminVideoText(value) {
  return String(value ?? '').trim();
}

function hasAdminVideoUrl(value) {
  const text = cleanAdminVideoText(value);
  return /^https?:\/\//i.test(text) || /^rtdb:/i.test(text);
}

function hasMeaningfulAdminTitle(value) {
  const text = cleanAdminVideoText(value);
  return Boolean(text && !/^untitled$/i.test(text));
}

function isEmptySupabaseVideoRow(row = {}) {
  const hasSource = [
    row.storage_url,
    row.stream_url,
    row.playback_url,
    row.embed_url,
    row.video_url,
  ].some(hasAdminVideoUrl);
  const hasThumbnail = hasAdminVideoUrl(row.thumbnail_url);
  const hasCreator = Boolean(cleanAdminVideoText(row.user_id) || cleanAdminVideoText(row.creator_display_name));

  return (
    !hasSource &&
    !hasThumbnail &&
    !hasCreator &&
    !hasMeaningfulAdminTitle(row.title)
  );
}

function isEmptyRtdbVideoRow(row = {}) {
  const hasSource = [
    row.videoUrl,
    row.streamUrl,
    row.videoSrc,
    row.url,
  ].some(hasAdminVideoUrl);
  const hasThumbnail = hasAdminVideoUrl(row.thumbnailUrl || row.thumbnail || row.poster);
  const hasCreator = Boolean(cleanAdminVideoText(row.userId) || cleanAdminVideoText(row.creatorDisplayName));

  return (
    !hasSource &&
    !hasThumbnail &&
    !hasCreator &&
    !hasMeaningfulAdminTitle(row.title)
  );
}

// Maps a Supabase tiktok_videos row to the standard admin Video shape.
// ID is plain — no prefix.
function mapSupabaseVideo(v, userMap) {
  const u = userMap[v.user_id] || {};
  const display = u.display_name || u.username || v.creator_display_name;
  const resolvedPrice = Number(v.token_price ?? v.coin_price ?? 0);
  const rawAccessType = String(v.access_type || '').toLowerCase();
  const legacyCoinGate = rawAccessType === 'members_only' || v.requires_membership === true || v.subscription_access === true;
  const isPremiumContent =
    v.is_premium_content === true ||
    Number(v.token_price || 0) > 0 ||
    Number(v.coin_price || 0) > 0 ||
    ['premium', 'coin_unlock'].includes(rawAccessType) ||
    legacyCoinGate;
  const accessType = normalizeAccessType(legacyCoinGate ? 'coin_unlock' : v.access_type, isPremiumContent ? (resolvedPrice > 0 ? 'coin_unlock' : 'premium') : 'free');
  return {
    id: v.video_id,
    title: v.title || 'Untitled',
    thumbnail: v.thumbnail_url || null,
    creatorName: display || 'Unknown',
    channelName: u.username || display || v.creator_display_name || '',
    uploadDate: v.created_at || null,
    status: v.status || 'published',
    visibility: v.visibility || 'public',
    views: Number(v.views_count || 0),
    likes: Number(v.likes_count || 0),
    reports: Number(v.reports_count || 0),
    earnings: Number(v.earnings || 0),
    price: Number.isFinite(resolvedPrice) ? resolvedPrice : 0,
    isPremiumContent,
    tokenPrice: Number(v.token_price || 0),
    accessType,
    access_type: accessType,
    premiumVisibility: v.premium_visibility || (accessType === 'free' ? 'public' : 'public_preview'),
    premium_visibility: v.premium_visibility || (accessType === 'free' ? 'public' : 'public_preview'),
    requiresMembership: false,
    requires_membership: false,
    subscriptionAccess: false,
    subscription_access: false,
    officialCompanyContent: v.official_company_content === true,
    official_company_content: v.official_company_content === true,
    contentSource: v.content_source || null,
    monetizationOwnerId: v.monetization_owner_id || null,
    videoUrl: v.storage_url || null,
    duration: v.duration || null,
    description: v.description || '',
    tags: v.tags || [],
    source: 'supabase',
    playable: v.playable === true,
    sourceType: v.source_type || null,
    validationStatus: v.validation_status || null,
    playbackUrl: v.playback_url || null,
    embedAllowed: v.embed_allowed === true,
  };
}

// Maps a Firebase RTDB video to the standard admin Video shape.
// ID is prefixed with "rtdb:" so update/delete handlers can route correctly.
function mapRtdbVideo(videoId, v) {
  const tokenPrice = Number(v.tokenPrice || v.coinPrice || 0);
  const rawAccessType = String(v.accessType || '').toLowerCase();
  const legacyCoinGate = rawAccessType === 'members_only' || v.requiresMembership === true || v.subscriptionAccess === true;
  const isPremiumContent =
    v.isPremiumContent === true ||
    tokenPrice > 0 ||
    ['premium', 'coin_unlock'].includes(rawAccessType) ||
    legacyCoinGate;
  const accessType = normalizeAccessType(legacyCoinGate ? 'coin_unlock' : v.accessType, isPremiumContent ? (tokenPrice > 0 ? 'coin_unlock' : 'premium') : 'free');
  return {
    id: `rtdb:${videoId}`,
    title: v.title || 'Untitled',
    thumbnail: v.thumbnailUrl || v.thumbnail_url || v.thumbnail || v.posterUrl || v.poster_url || v.poster || v.thumbUrl || v.thumb_url || v.thumb || null,
    creatorName: v.creatorDisplayName || 'Unknown',
    channelName: v.creatorDisplayName || '',
    uploadDate: v.createdAt ? new Date(v.createdAt).toISOString() : null,
    status: v.isLive === false ? 'removed' : 'published',
    visibility: 'public',
    views: Number(v.totalViews || 0),
    likes: Number(v.totalLikes || 0),
    reports: 0,
    earnings: 0,
    price: tokenPrice,
    isPremiumContent,
    tokenPrice,
    accessType,
    access_type: accessType,
    premiumVisibility: v.premiumVisibility || (accessType === 'free' ? 'public' : 'public_preview'),
    premium_visibility: v.premiumVisibility || (accessType === 'free' ? 'public' : 'public_preview'),
    requiresMembership: false,
    requires_membership: false,
    subscriptionAccess: false,
    subscription_access: false,
    officialCompanyContent: v.officialCompanyContent === true,
    official_company_content: v.officialCompanyContent === true,
    contentSource: v.contentSource || null,
    videoUrl: v.videoUrl || v.streamUrl || null,
    duration: v.durationSeconds || null,
    description: v.description || '',
    tags: Array.isArray(v.tags) ? v.tags : [],
    source: 'rtdb',
    ...(() => {
      const validation = validateVideoPlaybackSource({
        streamUrl: v.videoUrl || v.streamUrl,
        videoUrl: v.videoUrl || v.streamUrl,
        source: 'rtdb',
      });
      return {
        playable: validation.playable,
        sourceType: validation.sourceType,
        validationStatus: validation.validationStatus,
        playbackUrl: validation.playbackUrl,
        embedAllowed: validation.embedAllowed,
      };
    })(),
  };
}

function mapImportedAdminVideo(v = {}) {
  const validation = validateVideoPlaybackSource({
    streamUrl: v.video_url,
    videoUrl: v.video_url,
    iframeEmbed: v.iframe_embed,
    iframe_embed: v.iframe_embed,
    playbackType: v.playback_type,
    playback_type: v.playback_type,
    source: 'imported_csv',
  });
  return {
    id: v.id,
    title: v.title || 'Untitled',
    thumbnail: v.thumbnail_url || null,
    thumbnailUrl: v.thumbnail_url || null,
    thumbnail_url: v.thumbnail_url || null,
    creatorName: v.creator_id || 'Imported',
    creatorId: v.creator_id || null,
    creator_id: v.creator_id || null,
    channelName: v.studio || v.category || 'Imported',
    uploadDate: v.created_at || null,
    publishDate: v.publish_date || null,
    publish_date: v.publish_date || null,
    status: 'published',
    visibility: 'public',
    views: Number(v.views || 0),
    likes: 0,
    reports: 0,
    earnings: 0,
    videoUrl: v.video_url || null,
    video_url: v.video_url || null,
    iframeEmbed: v.iframe_embed || null,
    iframe_embed: v.iframe_embed || null,
    playbackType: v.iframe_embed ? 'external_embed' : (v.playback_type || 'external_redirect'),
    playback_type: v.iframe_embed ? 'external_embed' : (v.playback_type || 'external_redirect'),
    duration: Number(v.duration || 0),
    description: String(v.metadata?.description || ''),
    tags: Array.isArray(v.tags) ? v.tags : [],
    actors: Array.isArray(v.actors) ? v.actors : [],
    category: v.category || null,
    quality: v.quality || null,
    studio: v.studio || null,
    metadata: v.metadata || {},
    createdAt: v.created_at || null,
    updatedAt: v.updated_at || null,
    importJobId: v.import_job_id || null,
    import_job_id: v.import_job_id || null,
    importStatus: v.import_jobs?.status || v.import_status || 'unknown',
    import_status: v.import_jobs?.status || v.import_status || 'unknown',
    source: 'imported_csv',
    playable: validation.playable,
    sourceType: validation.sourceType,
    validationStatus: validation.validationStatus,
    playbackUrl: validation.playbackUrl,
    embedAllowed: validation.embedAllowed,
  };
}

function cleanSearchTerm(value) {
  return String(value || '')
    .trim()
    .replace(/['"]/g, '')
    .replace(/[%_]/g, '')
    .replace(/[(),]/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 120);
}

const IMPORTED_VIDEO_SELECT = [
  'id',
  'video_url',
  'iframe_embed',
  'playback_type',
  'title',
  'duration',
  'thumbnail_url',
  'tags',
  'actors',
  'views',
  'category',
  'quality',
  'studio',
  'publish_date',
  'metadata',
  'creator_id',
  'import_job_id',
  'created_at',
  'updated_at',
  'import_jobs(status)',
].join(',');

const IMPORTED_VIDEO_SELECT_LEGACY = [
  'id',
  'video_url',
  'title',
  'duration',
  'thumbnail_url',
  'tags',
  'actors',
  'views',
  'category',
  'quality',
  'studio',
  'publish_date',
  'metadata',
  'import_job_id',
  'created_at',
  'updated_at',
  'import_jobs(status)',
].join(',');

function isPremiumSupabaseRow(v) {
  return (
    v?.is_premium_content === true ||
    Number(v?.token_price || 0) > 0 ||
    Number(v?.coin_price || 0) > 0 ||
    ['premium', 'members_only', 'coin_unlock'].includes(String(v?.access_type || '').toLowerCase()) ||
    v?.requires_membership === true ||
    v?.subscription_access === true
  );
}

function isPremiumRtdbRow(v) {
  return (
    v?.isPremiumContent === true ||
    Number(v?.tokenPrice || 0) > 0 ||
    Number(v?.coinPrice || 0) > 0 ||
    ['premium', 'members_only', 'coin_unlock'].includes(String(v?.accessType || '').toLowerCase()) ||
    v?.requiresMembership === true ||
    v?.subscriptionAccess === true
  );
}

// Fetch recent videos from Firebase RTDB, apply filters, return mapped array.
async function fetchRtdbVideos({ search, statusFilter, isPremium }) {
  try {
    const rtdb = getFirebaseRtdb();
    if (!rtdb) return [];
    const ref = rtdb.ref('videos');
    const snapshots = [await ref.orderByKey().limitToLast(5000).once('value')];

    const byId = new Map();
    for (const snap of snapshots) {
      const val = snap.val();
      if (!val || typeof val !== 'object') continue;
      for (const [id, v] of Object.entries(val)) {
        byId.set(id, { _id: id, ...(v && typeof v === 'object' ? v : {}) });
      }
    }
    let list = [...byId.values()].filter((v) => !isEmptyRtdbVideoRow(v));

    // statusFilter mapping: 'published' → isLive true, 'removed' → isLive false, others → skip RTDB (no concept)
    if (statusFilter === 'blocked' || statusFilter === 'pending') return []; // RTDB has no blocked/pending
    if (statusFilter === 'published') list = list.filter(v => v.isLive === true);
    if (statusFilter === 'removed') list = list.filter(v => v.isLive === false);

    if (isPremium === 'true') {
      list = list.filter(v => isPremiumRtdbRow(v));
    } else if (isPremium === 'false') {
      list = list.filter(v => !isPremiumRtdbRow(v));
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(v => (v.title || '').toLowerCase().includes(q));
    }

    return list.map(v => mapRtdbVideo(v._id, v));
  } catch {
    return [];
  }
}

// Fetch all matching videos from Supabase tiktok_videos (no pagination — we merge in memory).
async function fetchSupabaseVideos({ search, statusFilter, isPremium, validationStatus }) {
  try {
    let q = supabase.from('tiktok_videos').select('*').order('created_at', { ascending: false }).limit(ADMIN_CONTENT_SOURCE_SCAN_LIMIT);
    if (statusFilter) q = q.eq('status', statusFilter);
    if (validationStatus) q = q.eq('validation_status', validationStatus);
    if (search) q = q.ilike('title', `%${search}%`);

    let { data, error } = await q;
    if (error) {
      if (isMissingTable(error)) return [];
      if (isMissingColumn(error)) {
        let retry = supabase.from('tiktok_videos').select('*').order('created_at', { ascending: false }).limit(ADMIN_CONTENT_SOURCE_SCAN_LIMIT);
        if (search) retry = retry.ilike('title', `%${search}%`);
        ({ data, error } = await retry);
        if (error) return [];
      } else {
        return [];
      }
    }

    let rows = (data || []).filter((row) => !isEmptySupabaseVideoRow(row));
    if (isPremium === 'true') {
      rows = rows.filter((v) => isPremiumSupabaseRow(v));
    } else if (isPremium === 'false') {
      rows = rows.filter((v) => !isPremiumSupabaseRow(v));
    }
    const userIds = [...new Set(rows.map(v => v.user_id).filter(Boolean))];
    const userMap = userIds.length ? await buildAdminUserFacetsByIds(userIds) : {};
    return rows.map(v => mapSupabaseVideo(v, userMap));
  } catch {
    return [];
  }
}

// ── GET /api/admin/content/videos ─────────────────────────────────────────────
// Merges Firebase RTDB (public videos) + Supabase tiktok_videos.
// isPremium=true filters to premium content from both sources.
// RTDB video IDs are prefixed with "rtdb:" so moderation actions route correctly.

function applyImportedVideoFilters(query, { search, category }) {
  const term = cleanSearchTerm(search);
  const categoryFilter = String(category || '').trim();
  let next = query;
  if (term) {
    next = next.or(`title.ilike.%${term}%,studio.ilike.%${term}%,category.ilike.%${term}%,video_url.ilike.%${term}%`);
  }
  if (categoryFilter) {
    next = next.eq('category', categoryFilter);
  }
  return next;
}

async function queryImportedVideos(selectClause, { search, category, offset, limit }) {
  let q = supabase
    .from('videos')
    .select(selectClause, { count: 'planned' });
  q = applyImportedVideoFilters(q, { search, category });
  return q
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
}

async function queryImportedVideoById(selectClause, id) {
  let q = supabase
    .from('videos')
    .select(selectClause);
  q = applyImportedVideoFilters(q, { search: '', category: '' });
  return q.eq('id', id).maybeSingle();
}

// GET /api/admin/content/imported-videos
export async function getImportedVideos(req, res) {
  try {
    const { search = '', category = '', page: rawPage, limit: rawLimit } = req.query;
    const { page, limit, offset } = paginate(rawPage, rawLimit);

    let { data, error, count } = await queryImportedVideos(IMPORTED_VIDEO_SELECT, {
      search,
      category,
      offset,
      limit,
    });

    if (error && isMissingColumn(error)) {
      ({ data, error, count } = await queryImportedVideos(IMPORTED_VIDEO_SELECT_LEGACY, {
        search,
        category,
        offset,
        limit,
      }));
    }

    if (error) {
      if (isMissingTable(error)) return res.json({ videos: [], total: 0, page, limit });
      return res.status(500).json({ message: error.message });
    }

    return res.json({
      videos: (data || []).map(mapImportedAdminVideo),
      total: Number(count || 0),
      page,
      limit,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// GET /api/admin/content/imported-videos/:id
export async function getImportedVideoById(req, res) {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ message: 'Video id is required.' });

    let { data, error } = await queryImportedVideoById(IMPORTED_VIDEO_SELECT, id);
    if (error && isMissingColumn(error)) {
      ({ data, error } = await queryImportedVideoById(IMPORTED_VIDEO_SELECT_LEGACY, id));
    }

    if (error) {
      if (isMissingTable(error)) return res.status(404).json({ message: 'Imported video not found.' });
      return res.status(500).json({ message: error.message });
    }
    if (!data) return res.status(404).json({ message: 'Imported video not found.' });

    return res.json({ video: mapImportedAdminVideo(data) });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// DELETE /api/admin/content/imported-videos/:id
export async function deleteImportedVideo(req, res) {
  try {
    const { id } = req.params;
    const { reason = '' } = req.body || {};
    if (!id) return res.status(400).json({ message: 'Video id is required.' });

    let { data: existing, error: lookupError } = await queryImportedVideoById(IMPORTED_VIDEO_SELECT, id);
    if (lookupError && isMissingColumn(lookupError)) {
      ({ data: existing, error: lookupError } = await queryImportedVideoById(IMPORTED_VIDEO_SELECT_LEGACY, id));
    }

    if (lookupError) {
      if (isMissingTable(lookupError)) return res.status(404).json({ message: 'Imported video not found.' });
      return res.status(500).json({ message: lookupError.message });
    }
    if (!existing) return res.status(404).json({ message: 'Imported video not found.' });

    const { error } = await supabase.from('videos').delete().eq('id', id);
    if (error) return res.status(500).json({ message: error.message });

    invalidateCreatorLeaderboard();
    enqueueSearchIndex(id, 'delete').catch(() => {});
    await logAction(req.admin?.id, req.admin?.name, 'Imported video deleted', 'imported_video', id, {
      reason,
      title: existing.title,
      videoUrl: existing.video_url,
    });

    return res.json({ message: 'Imported video deleted successfully.' });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

function hasRawIframeEmbed(value) {
  return /<iframe\b/i.test(String(value || ''));
}

async function selectImportedVideosWithoutIframe(limit) {
  const selectColumns = 'id, title, video_url, iframe_embed, import_job_id';
  const { data: nullRows, error: nullError } = await supabase
    .from('videos')
    .select(selectColumns)
    .not('import_job_id', 'is', null)
    .is('iframe_embed', null)
    .limit(limit);
  if (nullError) return { data: [], error: nullError };

  const remaining = Math.max(0, limit - (nullRows || []).length);
  if (!remaining) return { data: nullRows || [], error: null };

  const { data: emptyRows, error: emptyError } = await supabase
    .from('videos')
    .select(selectColumns)
    .not('import_job_id', 'is', null)
    .eq('iframe_embed', '')
    .limit(remaining);
  if (emptyError) return { data: [], error: emptyError };

  const nextRemaining = Math.max(0, remaining - (emptyRows || []).length);
  if (!nextRemaining) return { data: [...(nullRows || []), ...(emptyRows || [])], error: null };

  const { data: nonIframeRows, error: nonIframeError } = await supabase
    .from('videos')
    .select(selectColumns)
    .not('import_job_id', 'is', null)
    .not('iframe_embed', 'ilike', '%<iframe%')
    .limit(nextRemaining);

  if (nonIframeError) {
    return { data: [...(nullRows || []), ...(emptyRows || [])], error: null };
  }

  const byId = new Map();
  for (const row of [...(nullRows || []), ...(emptyRows || []), ...(nonIframeRows || [])]) {
    if (row?.id) byId.set(row.id, row);
  }
  return { data: [...byId.values()], error: null };
}

// DELETE /api/admin/content/imported-videos/without-iframe
export async function deleteImportedVideosWithoutIframe(req, res) {
  try {
    const batchSize = Math.max(50, Math.min(1000, Number(req.query.batchSize || 500) || 500));
    const maxDeletes = Math.max(1, Math.min(250000, Number(req.query.maxDeletes || 250000) || 250000));
    let deleted = 0;
    let scanned = 0;
    const sampleIds = [];

    while (deleted < maxDeletes) {
      const { data, error } = await selectImportedVideosWithoutIframe(Math.min(batchSize, maxDeletes - deleted));
      if (error) {
        if (isMissingTable(error)) return res.json({ message: 'No imported videos table found.', deleted, scanned, ids: sampleIds });
        return res.status(500).json({ message: error.message });
      }

      scanned += (data || []).length;
      const ids = [...new Set((data || [])
        .filter((row) => row?.id && !hasRawIframeEmbed(row.iframe_embed))
        .map((row) => row.id))];
      if (!ids.length) break;

      const { error: deleteError } = await supabase.from('videos').delete().in('id', ids);
      if (deleteError) return res.status(500).json({ message: deleteError.message, deleted, scanned });

      deleted += ids.length;
      if (sampleIds.length < 20) sampleIds.push(...ids.slice(0, 20 - sampleIds.length));
      if (ids.length < batchSize) break;
    }

    if (deleted) invalidateCreatorLeaderboard();
    await logAction(req.admin?.id, req.admin?.name, 'Imported videos without iframe deleted', 'imported_video', 'bulk', {
      deleted,
      scanned,
    });

    return res.json({
      message: deleted
        ? `Deleted ${deleted} imported video${deleted === 1 ? '' : 's'} without iframe playback.`
        : 'No imported videos without iframe playback were found.',
      deleted,
      scanned,
      ids: sampleIds,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

export async function getVideos(req, res) {
  try {
    const { search = '', statusFilter = '', isPremium = '', validationStatus = '', page: rawPage, limit: rawLimit } = req.query;
    const { page, limit, offset } = paginate(rawPage, rawLimit);

    const [rtdbVideos, supabaseVideos] = await Promise.all([
      fetchRtdbVideos({ search, statusFilter, isPremium }),
      fetchSupabaseVideos({ search, statusFilter, isPremium, validationStatus }),
    ]);

    let all = [...rtdbVideos, ...supabaseVideos];
    if (validationStatus) {
      all = all.filter((v) => v.validationStatus === validationStatus);
    }
    all.sort((a, b) => new Date(b.uploadDate || 0).getTime() - new Date(a.uploadDate || 0).getTime());

    const total = all.length;
    const videos = all.slice(offset, offset + limit);
    return res.json({ videos, total, page, limit });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/content/videos/:id ─────────────────────────────────────────

export async function cleanupEmptyVideos(req, res) {
  try {
    const maxScan = Math.max(100, Math.min(50000, Number(req.query.maxScan || 20000) || 20000));
    const pageSize = 1000;
    const supabaseCandidates = [];
    const rtdbCandidates = [];
    let supabaseScanned = 0;
    let rtdbScanned = 0;

    if (supabase) {
      for (let from = 0; from < maxScan; from += pageSize) {
        const { data, error } = await supabase
          .from('tiktok_videos')
          .select('*')
          .order('created_at', { ascending: false })
          .range(from, Math.min(from + pageSize - 1, maxScan - 1));

        if (error) {
          if (isMissingTable(error)) break;
          return res.status(500).json({ message: error.message });
        }

        const rows = data || [];
        supabaseScanned += rows.length;
        for (const row of rows) {
          if (row?.video_id && isEmptySupabaseVideoRow(row)) supabaseCandidates.push(row.video_id);
        }
        if (rows.length < pageSize) break;
      }
    }

    const rtdb = getFirebaseRtdb();
    if (rtdb) {
      const snap = await rtdb.ref('videos').orderByKey().limitToFirst(maxScan).once('value');
      const val = snap.val();
      const entries = val && typeof val === 'object' ? Object.entries(val) : [];
      rtdbScanned = entries.length;
      for (const [id, row] of entries) {
        const normalized = { _id: id, ...(row && typeof row === 'object' ? row : {}) };
        if (isEmptyRtdbVideoRow(normalized)) rtdbCandidates.push(id);
      }
    }

    const supabaseIds = [...new Set(supabaseCandidates)];
    for (let i = 0; i < supabaseIds.length; i += 100) {
      const chunk = supabaseIds.slice(i, i + 100);
      const { error } = await supabase.from('tiktok_videos').delete().in('video_id', chunk);
      if (error) return res.status(500).json({ message: error.message, deleted: i });
      chunk.forEach((id) => enqueueSearchIndex(id, 'delete').catch(() => {}));
    }

    const rtdbIds = [...new Set(rtdbCandidates)];
    if (rtdb && rtdbIds.length) {
      const ref = rtdb.ref('videos');
      for (let i = 0; i < rtdbIds.length; i += 100) {
        await Promise.all(rtdbIds.slice(i, i + 100).map((id) => ref.child(id).remove()));
      }
    }

    const deleted = supabaseIds.length + rtdbIds.length;
    const scanned = supabaseScanned + rtdbScanned;
    if (deleted) invalidateCreatorLeaderboard();
    await logAction(req.admin?.id, req.admin?.name, 'Empty videos cleaned up', 'video', 'bulk', {
      deleted,
      scanned,
      supabaseDeleted: supabaseIds.length,
      rtdbDeleted: rtdbIds.length,
    });

    return res.json({
      message: deleted ? `Removed ${deleted} empty video${deleted === 1 ? '' : 's'}.` : 'No empty videos found.',
      deleted,
      scanned,
      ids: [...supabaseIds, ...rtdbIds.map((id) => `rtdb:${id}`)],
      sources: {
        supabase: { deleted: supabaseIds.length, scanned: supabaseScanned },
        rtdb: { deleted: rtdbIds.length, scanned: rtdbScanned },
      },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

export async function getVideoById(req, res) {
  try {
    const { id } = req.params;
    if (id.startsWith('rtdb:')) {
      const realId = id.slice(5);
      const rtdb = getFirebaseRtdb();
      if (!rtdb) return res.status(503).json({ message: 'Firebase unavailable.' });
      const snap = await rtdb.ref(`videos/${realId}`).once('value');
      const v = snap.val();
      if (!v) return res.status(404).json({ message: 'Video not found.' });
      return res.json({ video: mapRtdbVideo(realId, v) });
    }
    const { data, error } = await supabase.from('tiktok_videos').select('*').eq('video_id', id).maybeSingle();
    if (error) return res.status(500).json({ message: error.message });
    if (!data) return res.status(404).json({ message: 'Video not found.' });
    const uid = data.user_id;
    const userMap = uid ? await buildAdminUserFacetsByIds([uid]) : {};
    return res.json({ video: mapSupabaseVideo(data, userMap) });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── PUT /api/admin/content/videos/:id/status ──────────────────────────────────

export async function updateVideoStatus(req, res) {
  try {
    const { id } = req.params;
    const { status, reason = '' } = req.body;
    const allowed = ['published', 'blocked', 'removed', 'pending'];
    if (!allowed.includes(status)) return res.status(400).json({ message: 'Invalid status.' });

    if (id.startsWith('rtdb:')) {
      const realId = id.slice(5);
      const rtdb = getFirebaseRtdb();
      if (!rtdb) return res.status(503).json({ message: 'Firebase unavailable.' });
      await rtdb.ref(`videos/${realId}`).update({ isLive: status === 'published' });
      invalidateCreatorLeaderboard();
      await logAction(req.admin?.id, req.admin?.name, `Video ${status}`, 'video', id, { reason, status });
      return res.json({ message: `Video ${status} successfully.` });
    }

    const updates = { status };
    if (status === 'blocked' || status === 'removed') {
      updates.playable = false;
      updates.validation_status = 'unsupported';
    }
    const { error } = await supabase.from('tiktok_videos').update(updates).eq('video_id', id);
    if (error) return res.status(500).json({ message: error.message });
    invalidateCreatorLeaderboard();
    await logAction(req.admin?.id, req.admin?.name, `Video ${status}`, 'video', id, { reason, status });
    return res.json({ message: `Video ${status} successfully.` });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

async function updateSupabasePremiumRows(videoIds, payload) {
  const ids = [...new Set((videoIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return [];

  let updates = premiumUpdateForSupabase(payload);
  let lastError = null;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const { data, error } = await supabase
      .from('tiktok_videos')
      .update(updates)
      .in('video_id', ids)
      .select('*');

    if (!error) return data || [];
    lastError = error;

    const missingColumn = extractMissingColumnName(error);
    if (!missingColumn || !(missingColumn in updates) || !isMissingColumn(error)) {
      throw error;
    }
    delete updates[missingColumn];
  }

  throw lastError || new Error('Failed to update premium settings.');
}

function splitVideoIds(ids = []) {
  const rtdb = [];
  const supabaseIds = [];
  for (const rawId of ids) {
    const id = String(rawId || '').trim();
    if (!id) continue;
    if (id.startsWith('rtdb:')) rtdb.push(id.slice(5));
    else supabaseIds.push(id);
  }
  return { rtdb, supabaseIds };
}

export async function updateVideoPremium(req, res) {
  try {
    const { id } = req.params;
    const payload = normalizePremiumPayload(req.body || {});

    if (id.startsWith('rtdb:')) {
      const realId = id.slice(5);
      const rtdb = getFirebaseRtdb();
      if (!rtdb) return res.status(503).json({ message: 'Firebase unavailable.' });
      await rtdb.ref(`videos/${realId}`).update(premiumUpdateForRtdb(payload));
      await logAction(req.admin?.id, req.admin?.name, 'Video premium settings updated', 'video', id, payload);
      return res.json({ message: 'Premium settings updated.', video: mapRtdbVideo(realId, { id: realId, ...premiumUpdateForRtdb(payload) }) });
    }

    const rows = await updateSupabasePremiumRows([id], payload);
    invalidateCreatorLeaderboard();
    enqueueSearchIndex(id, 'upsert').catch(() => {});
    await logAction(req.admin?.id, req.admin?.name, 'Video premium settings updated', 'video', id, payload);

    if (!rows.length) return res.status(404).json({ message: 'Video not found.' });
    const userIds = [...new Set(rows.map((v) => v.user_id).filter(Boolean))];
    const userMap = userIds.length ? await buildAdminUserFacetsByIds(userIds) : {};
    return res.json({ message: 'Premium settings updated.', video: mapSupabaseVideo(rows[0], userMap) });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ message: err.message });
  }
}

export async function bulkUpdateVideoPremium(req, res) {
  try {
    const rawIds = req.body?.videoIds || req.body?.ids || [];
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return res.status(400).json({ message: 'videoIds must be a non-empty array.' });
    }
    const videoIds = rawIds.slice(0, 1000);
    const payload = normalizePremiumPayload(req.body || {});
    const { rtdb, supabaseIds } = splitVideoIds(videoIds);

    let updated = 0;
    if (rtdb.length) {
      const rtdbClient = getFirebaseRtdb();
      if (!rtdbClient) return res.status(503).json({ message: 'Firebase unavailable.' });
      const rtdbUpdates = premiumUpdateForRtdb(payload);
      await Promise.all(rtdb.map((id) => rtdbClient.ref(`videos/${id}`).update(rtdbUpdates)));
      updated += rtdb.length;
    }

    for (let i = 0; i < supabaseIds.length; i += 100) {
      const chunk = supabaseIds.slice(i, i + 100);
      const rows = await updateSupabasePremiumRows(chunk, payload);
      updated += rows.length;
      rows.forEach((row) => enqueueSearchIndex(row.video_id, 'upsert').catch(() => {}));
    }

    invalidateCreatorLeaderboard();
    await logAction(req.admin?.id, req.admin?.name, 'Bulk video premium settings updated', 'video', 'bulk', {
      ...payload,
      requested: videoIds.length,
      updated,
    });

    return res.json({ message: 'Premium settings updated.', updated, requested: videoIds.length, payload });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ message: err.message });
  }
}

export async function revalidateVideos(req, res) {
  try {
    const dryRun = String(req.query.dryRun || '0') === '1';
    const { data: rows, error } = await supabase.from('tiktok_videos').select('video_id, storage_url, stream_url, embed_url, source');
    if (error) return res.status(500).json({ message: error.message });

    let updated = 0;
    let unsupported = 0;
    const results = [];

    for (const row of rows || []) {
      const validation = validateVideoPlaybackSource({
        source: 'community',
        streamUrl: row.stream_url || row.storage_url,
        storage_url: row.storage_url,
        videoUrl: row.storage_url,
        embedUrl: row.embed_url,
      });
      if (!validation.playable) unsupported += 1;
      results.push({ videoId: row.video_id, ...validation });
      if (!dryRun) {
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
    }

    await logAction(req.admin?.id, req.admin?.name, 'Bulk revalidate videos', 'video', 'bulk', {
      dryRun,
      total: (rows || []).length,
      updated,
      unsupported,
    });

    return res.json({
      dryRun,
      total: (rows || []).length,
      updated: dryRun ? 0 : updated,
      unsupported,
      sample: results.slice(0, 20),
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── DELETE /api/admin/content/videos/:id ──────────────────────────────────────

export async function deleteVideo(req, res) {
  try {
    const { id } = req.params;
    const { reason = '' } = req.body;

    if (id.startsWith('rtdb:')) {
      const realId = id.slice(5);
      const rtdb = getFirebaseRtdb();
      if (!rtdb) return res.status(503).json({ message: 'Firebase unavailable.' });
      await rtdb.ref(`videos/${realId}`).remove();
      await logAction(req.admin?.id, req.admin?.name, 'Video deleted', 'video', id, { reason });
      return res.json({ message: 'Video deleted successfully.' });
    }

    const { error } = await supabase.from('tiktok_videos').delete().eq('video_id', id);
    if (error) return res.status(500).json({ message: error.message });
    await logAction(req.admin?.id, req.admin?.name, 'Video deleted', 'video', id, { reason });
    return res.json({ message: 'Video deleted successfully.' });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/content/lives ──────────────────────────────────────────────

export async function getLiveSessions(req, res) {
  try {
    const { search = '', statusFilter = '' } = req.query;
    const { page, limit, offset } = paginate(req.query.page, req.query.limit);

    let countQ = supabase.from('lives').select('*', { count: 'exact', head: true });
    if (statusFilter) countQ = countQ.eq('status', statusFilter);
    if (search) countQ = countQ.or(`host_id.ilike.%${search}%`);

    const { count, error: countErr } = await countQ;
    if (countErr) {
      if (isMissingTable(countErr)) return res.json({ lives: [], total: 0, page, limit });
      return res.status(500).json({ message: countErr.message });
    }

    const total = count || 0;
    if (total === 0 || offset >= total) return res.json({ lives: [], total, page, limit });

    let q = supabase.from('lives').select(
      'id, host_id, status, viewers_count, total_likes, total_gifts_amount, created_at, ended_at'
    );
    if (statusFilter) q = q.eq('status', statusFilter);
    if (search) q = q.or(`host_id.ilike.%${search}%`);
    q = q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

    const { data, error } = await q;
    if (error) return res.status(500).json({ message: error.message });

    // Enrich with host display names
    const lives = data || [];
    const hostIds = [...new Set(lives.map(l => l.host_id).filter(Boolean))];
    const userMap = hostIds.length ? await buildAdminUserFacetsByIds(hostIds) : {};

    const enriched = lives.map(l => ({
      ...l,
      hostName: userMap[l.host_id]?.display_name || userMap[l.host_id]?.username || 'Unknown',
      hostAvatar: userMap[l.host_id]?.avatar || null,
    }));

    return res.json({ lives: enriched, total, page, limit });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/content/lives/:id ─────────────────────────────────────────

export async function getLiveSessionById(req, res) {
  try {
    const { id } = req.params;

    const { data: live, error } = await supabase
      .from('lives')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) return res.status(500).json({ message: error.message });
    if (!live) return res.status(404).json({ message: 'Live session not found.' });

    // Enrich host info
    let host = null;
    if (live.host_id) {
      const map = await buildAdminUserFacetsByIds([live.host_id]);
      host = map[live.host_id] || null;
    }

    // Fetch gifts for this live
    const { data: gifts } = await supabase
      .from('live_gifts')
      .select('*')
      .eq('live_id', id)
      .order('created_at', { ascending: false })
      .limit(100);

    // Fetch viewers
    const { data: viewers } = await supabase
      .from('live_viewers')
      .select('*')
      .eq('live_id', id)
      .order('joined_at', { ascending: false })
      .limit(100);

    return res.json({
      live: {
        ...live,
        hostName: host?.display_name || host?.username || 'Unknown',
        hostAvatar: host?.avatar || null,
      },
      gifts: gifts || [],
      viewers: viewers || [],
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── PUT /api/admin/content/lives/:id/status ───────────────────────────────────

export async function updateLiveStatus(req, res) {
  try {
    const { id } = req.params;
    const { status, reason = '' } = req.body;
    const allowed = ['live', 'ended', 'paused', 'banned'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: 'Invalid status.' });
    }

    const { error } = await supabase.from('lives').update({ status }).eq('id', id);
    if (error) return res.status(500).json({ message: error.message });

    await logAction(req.admin?.id, req.admin?.name, `Live ${status}`, 'live', id, { reason });
    return res.json({ message: `Live session ${status} successfully.` });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/content/random-sessions ────────────────────────────────────

function groupRandomUsageRows(rows = []) {
  const grouped = new Map();

  for (const row of rows) {
    const roomId = String(row.room_id || '').trim();
    if (!roomId) continue;

    const existing = grouped.get(roomId) || {
      id: roomId,
      room_id: roomId,
      user1_id: null,
      user2_id: null,
      status: 'ended',
      created_at: row.started_at || row.created_at,
      ended_at: row.ended_at || null,
      connected_at: row.connected_at || null,
      duration_seconds: 0,
      coins_spent: 0,
      gifts_sent: 0,
      revenue_generated: 0,
      reports: 0,
      participants: [],
    };

    const userId = String(row.user_id || '').trim();
    const peerId = String(row.peer_user_id || '').trim();
    if (userId && !existing.participants.includes(userId)) existing.participants.push(userId);
    if (peerId && !existing.participants.includes(peerId)) existing.participants.push(peerId);
    if (!existing.user1_id && userId) existing.user1_id = userId;
    else if (userId && existing.user1_id !== userId && !existing.user2_id) existing.user2_id = userId;
    if (peerId && existing.user1_id !== peerId && !existing.user2_id) existing.user2_id = peerId;

    if (row.status === 'active') existing.status = 'active';
    else if (existing.status !== 'active' && row.status === 'exhausted') existing.status = 'exhausted';
    else if (existing.status !== 'active' && row.status === 'failed') existing.status = 'failed';

    const startedAt = row.started_at || row.created_at;
    if (startedAt && (!existing.created_at || new Date(startedAt) < new Date(existing.created_at))) {
      existing.created_at = startedAt;
    }
    if (row.ended_at && (!existing.ended_at || new Date(row.ended_at) > new Date(existing.ended_at))) {
      existing.ended_at = row.ended_at;
    }
    if (row.connected_at && !existing.connected_at) existing.connected_at = row.connected_at;

    existing.duration_seconds = Math.max(existing.duration_seconds, Number(row.duration_seconds || 0));
    existing.coins_spent += Number(row.coins_spent || 0);
    existing.revenue_generated += Number(row.coins_spent || 0);

    grouped.set(roomId, existing);
  }

  return Array.from(grouped.values()).map((session) => ({
  ...session,
  participants: session.participants.slice(0, 2),
  }));
}

export async function getRandomSessions(req, res) {
  try {
    const { search = '', statusFilter = '' } = req.query;
    const { page, limit, offset } = paginate(req.query.page, req.query.limit);

    let rows = [];
    if (supabase) {
      const { data, error } = await supabase
        .from('random_chat_usage')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(2000);

      if (error && !isMissingTable(error)) {
        return res.status(500).json({ message: error.message });
      }
      rows = data || [];
    }

    const { getActiveChatRooms } = await import('../services/chatRoomRegistry.service.js');
    const activeRooms = getActiveChatRooms();

    for (const room of activeRooms) {
      rows.push({
        room_id: room.id,
        user_id: room.user1_id,
        peer_user_id: room.user2_id,
        status: 'active',
        started_at: room.created_at,
        connected_at: room.connected_at || null,
        ended_at: null,
        duration_seconds: Number(room.duration_seconds || 0),
        coins_spent: Number(room.coins_spent || 0),
      });
    }

    let sessions = groupRandomUsageRows(rows);

    const needle = String(search || '').trim().toLowerCase();
    if (needle) {
      sessions = sessions.filter((session) =>
        String(session.id).toLowerCase().includes(needle)
        || String(session.user1_id || '').toLowerCase().includes(needle)
        || String(session.user2_id || '').toLowerCase().includes(needle),
      );
    }
    if (statusFilter) {
      sessions = sessions.filter((session) => session.status === statusFilter);
    }

    sessions.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    const total = sessions.length;
    const paged = sessions.slice(offset, offset + limit);
  const activeCount = sessions.filter((session) => session.status === 'active').length;

    return res.json({ sessions: paged, total, page, limit, activeCount });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/content/random-sessions/:id ────────────────────────────────

export async function getRandomSessionById(req, res) {
  try {
    const roomId = String(req.params.id || '').trim();
    if (!roomId) return res.status(400).json({ message: 'Session id is required' });

    let usageRows = [];
    if (supabase) {
      const { data, error } = await supabase
        .from('random_chat_usage')
        .select('*')
        .eq('room_id', roomId)
        .order('started_at', { ascending: true });

      if (error && !isMissingTable(error)) {
        return res.status(500).json({ message: error.message });
      }
      usageRows = data || [];
    }

    const { getActiveChatRooms } = await import('../services/chatRoomRegistry.service.js');
    const active = getActiveChatRooms().find((room) => room.id === roomId);
    if (active && !usageRows.length) {
      usageRows = [{
        room_id: roomId,
        user_id: active.user1_id,
        peer_user_id: active.user2_id,
        status: 'active',
        started_at: active.created_at,
        connected_at: active.connected_at || null,
        duration_seconds: active.duration_seconds || 0,
        coins_spent: active.coins_spent || 0,
      }];
    }

    const grouped = groupRandomUsageRows(usageRows);
    const session = grouped[0] || {
      id: roomId,
      room_id: roomId,
      status: active ? 'active' : 'unknown',
      created_at: active?.created_at || null,
      user1_id: active?.user1_id || null,
      user2_id: active?.user2_id || null,
    };

    let reports = [];
    if (supabase) {
      const { data } = await supabase
        .from('ai_moderation_signals')
        .select('id,user_id,event_type,message,metadata,created_at')
        .eq('session_id', roomId)
        .in('event_type', ['user_report', 'gift_activity'])
        .order('created_at', { ascending: false })
        .limit(50);
      reports = (data || []).map((row) => ({
        id: row.id,
        reporter: row.user_id,
        reason: row.message || row.event_type,
        timestamp: row.created_at,
      }));
    }

    return res.json({
      session: {
        ...session,
        reports: reports.length,
        isLive: session.status === 'active',
      },
      usage: usageRows,
      reports,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── POST /api/admin/content/random-sessions/:id/disconnect ────────────────────

export async function forceDisconnectRandomSession(req, res) {
  try {
    const roomId = String(req.params.id || '').trim();
    if (!roomId) return res.status(400).json({ message: 'Session id is required' });

    const { adminForceEndChatRoom } = await import('../services/chatRoomRegistry.service.js');
    const ended = adminForceEndChatRoom(roomId);
    if (!ended) return res.status(404).json({ message: 'Active session not found in memory.' });

    await logAction(req.admin?.uid, req.admin?.email, 'force_disconnect_random_session', 'random_session', roomId, {
      reason: req.body?.reason || 'admin_force_disconnect',
    });

    return res.json({ ok: true, message: 'Session disconnected.' });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/content/premium-videos ─────────────────────────────────────
// Delegates to getVideos with isPremium=true — no separate DB query.

export async function getPremiumVideos(req, res) {
  req.query.isPremium = 'true';
  return getVideos(req, res);
}
