import {
  getImportedVideo,
  listImportedVideoCategories,
  listImportedVideos,
} from '../services/enterpriseImport.service.js';
import { annotateFeedListableVideo } from '../utils/videoPlaybackValidation.js';

function mapImportedVideo(row = {}) {
  const iframeEmbed = row.iframe_embed || null;
  const playbackType = iframeEmbed ? 'external_embed' : (row.playback_type || 'external_redirect');
  const base = {
    id: row.id,
    videoUrl: row.video_url,
    video_url: row.video_url,
    iframeEmbed,
    iframe_embed: iframeEmbed,
    playbackType,
    playback_type: playbackType,
    pageUrl: row.video_url,
    page_url: row.video_url,
    externalUrl: row.video_url,
    external_url: row.video_url,
    title: row.title,
    duration: Number(row.duration || 0),
    durationSeconds: Number(row.duration || 0),
    duration_seconds: Number(row.duration || 0),
    thumbnail: row.thumbnail_url || null,
    thumbnailUrl: row.thumbnail_url || null,
    thumbnail_url: row.thumbnail_url || null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    actors: Array.isArray(row.actors) ? row.actors : [],
    views: Number(row.views || 0),
    category: row.category || null,
    quality: row.quality || null,
    studio: row.studio || null,
    publishDate: row.publish_date || null,
    publish_date: row.publish_date || null,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    source: 'imported_csv',
    contentSource: 'imported_csv',
    content_source: 'imported_csv',
  };
  return annotateFeedListableVideo(base);
}

export async function getImportedVideos(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const category = String(req.query.category || '').trim() || null;
    const rows = await listImportedVideos({ page, limit, category });
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    return res.json({
      success: true,
      data: rows.map(mapImportedVideo),
      page,
      limit,
      hasMore: rows.length >= limit,
      source: 'supabase',
      category,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error?.message || 'Failed to load imported videos' });
  }
}

export async function getImportedVideoCategories(req, res) {
  try {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
    const rows = await listImportedVideoCategories({ limit });
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=1800');
    return res.json({
      success: true,
      data: rows,
      count: rows.length,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error?.message || 'Failed to load imported categories' });
  }
}

export async function getImportedVideoById(req, res) {
  try {
    const row = await getImportedVideo(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Imported video not found' });
    return res.json({ success: true, data: mapImportedVideo(row) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error?.message || 'Failed to load imported video' });
  }
}
