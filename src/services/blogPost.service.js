import { randomUUID } from 'crypto';
import sanitizeHtml from 'sanitize-html';
import { supabase, isConfigured, uploadFileToBucket, getPublicUrl, IMAGE_BUCKET } from '../config/supabase.js';

const TABLE = 'blog_posts';
const STATUSES = new Set(['draft', 'published', 'archived']);
export const XSTREAM_BLOG_AUTHOR = 'XstreamVideos Editorial Team';
const XSTREAM_AUTHOR_QUERY = '%xstream%';
const BLOG_IMAGE_MAX_MB = Number(process.env.BLOG_IMAGE_MAX_MB || 8);
const BLOG_IMAGE_MAX_BYTES = Math.max(1, Number.isFinite(BLOG_IMAGE_MAX_MB) ? BLOG_IMAGE_MAX_MB : 8) * 1024 * 1024;
const BLOG_IMAGE_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
]);

export function isMissingBlogDbFeature(error) {
  const message = String(error?.message || '');
  return (
    error?.code === '42P01' ||
    error?.code === '42703' ||
    error?.code === 'PGRST200' ||
    error?.code === 'PGRST204' ||
    /schema cache|does not exist|column .* not found/i.test(message)
  );
}

function assertConfigured() {
  if (!isConfigured() || !supabase) {
    const err = new Error('Database is not configured. Blog management is unavailable.');
    err.status = 503;
    throw err;
  }
}

function cleanString(value, max = 1000) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
}

export function isXstreamBlogAuthor(value) {
  return /xstream/i.test(cleanString(value, 180));
}

function stripHtml(value) {
  return sanitizeHtml(String(value || ''), { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100000);
}

export function normalizeBlogSlug(value, fallback = '') {
  const slug = cleanString(value || fallback, 180)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 150);
  return slug || `article-${Date.now()}`;
}

function normalizeStatus(value, fallback = 'draft') {
  const status = cleanString(value, 24).toLowerCase();
  return STATUSES.has(status) ? status : fallback;
}

function normalizeUrl(value) {
  const url = cleanString(value, 1000);
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : null;
}

function safeStorageSegment(value, fallback = 'editor') {
  return cleanString(value, 120)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || fallback;
}

function originalImageName(file = {}) {
  return cleanString(file.originalname || file.name || 'blog-image', 180)
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'blog-image';
}

function blogImageExtension(file = {}) {
  const contentType = cleanString(file.mimetype || file.type, 120).toLowerCase();
  if (BLOG_IMAGE_TYPES.has(contentType)) return BLOG_IMAGE_TYPES.get(contentType);
  const original = originalImageName(file).toLowerCase();
  const ext = original.match(/\.([a-z0-9]{2,5})$/)?.[1] || '';
  if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext;
  return '';
}

function normalizeTags(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || '').split(',');
  return [...new Set(raw
    .map((tag) => cleanString(tag, 48).toLowerCase())
    .filter(Boolean)
    .slice(0, 24))];
}

function normalizeSeo(input = {}, fallback = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    pageTitle: cleanString(source.pageTitle || `${fallback.title || 'Blog'} | XstreamVideos`, 180),
    metaTitle: cleanString(source.metaTitle || fallback.title || '', 180),
    metaDescription: cleanString(source.metaDescription || fallback.summary || '', 320),
    canonicalUrl: cleanString(source.canonicalUrl || `/blog/${fallback.slug || ''}`, 500),
    ogTitle: cleanString(source.ogTitle || fallback.title || '', 180),
    ogDescription: cleanString(source.ogDescription || fallback.summary || '', 320),
    ogImage: cleanString(source.ogImage || fallback.coverImageUrl || '', 1000),
  };
}

export function sanitizeBlogHtml(value) {
  return sanitizeHtml(String(value || ''), {
    allowedTags: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'br', 'hr',
      'strong', 'b', 'em', 'i', 'u', 's',
      'ul', 'ol', 'li',
      'blockquote', 'code', 'pre',
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
      'a', 'img', 'figure', 'figcaption',
      'video', 'source',
      'span',
    ],
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'decoding'],
      video: ['src', 'poster', 'controls', 'preload', 'width', 'height', 'title'],
      source: ['src', 'type'],
      table: ['summary'],
      th: ['scope', 'colspan', 'rowspan'],
      td: ['colspan', 'rowspan'],
      '*': ['id'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: {
      img: ['http', 'https', 'data'],
      video: ['http', 'https'],
      source: ['http', 'https'],
    },
    transformTags: {
      a: (_tagName, attribs) => ({
        tagName: 'a',
        attribs: {
          ...attribs,
          rel: 'noopener noreferrer',
          target: attribs.href && /^https?:\/\//i.test(attribs.href) ? '_blank' : attribs.target,
        },
      }),
      img: (_tagName, attribs) => ({
        tagName: 'img',
        attribs: {
          ...attribs,
          alt: cleanString(attribs.alt || 'Blog image', 160),
          loading: 'lazy',
          decoding: 'async',
        },
      }),
      video: (_tagName, attribs) => ({
        tagName: 'video',
        attribs: {
          ...attribs,
          controls: 'controls',
          preload: attribs.preload || 'metadata',
        },
      }),
    },
  }).trim();
}

export async function uploadBlogPostImage(file, admin = {}) {
  assertConfigured();
  if (!file?.buffer || !file?.size) {
    const err = new Error('Choose a valid image file.');
    err.status = 400;
    throw err;
  }

  const contentType = cleanString(file.mimetype || file.type, 120).toLowerCase();
  if (!BLOG_IMAGE_TYPES.has(contentType)) {
    const err = new Error('Blog images must be JPG, PNG, WebP, or GIF files.');
    err.status = 400;
    throw err;
  }

  if (Number(file.size || 0) > BLOG_IMAGE_MAX_BYTES) {
    const err = new Error(`Blog image is too large. Upload an image under ${Math.round(BLOG_IMAGE_MAX_BYTES / 1024 / 1024)} MB.`);
    err.status = 413;
    throw err;
  }

  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const editor = safeStorageSegment(admin.email || admin.id || 'editor');
  const ext = blogImageExtension(file) || BLOG_IMAGE_TYPES.get(contentType);
  const storagePath = `blog/${yyyy}/${mm}/${editor}/${Date.now()}-${randomUUID()}.${ext}`;

  const data = await uploadFileToBucket(IMAGE_BUCKET, storagePath, file, contentType);
  const storedPath = data?.path || storagePath;
  const url = getPublicUrl(IMAGE_BUCKET, storedPath);
  if (!url) {
    const err = new Error('Blog image uploaded, but no public URL was returned.');
    err.status = 502;
    throw err;
  }

  return {
    url,
    path: storedPath,
    bucket: IMAGE_BUCKET,
    fileName: originalImageName(file),
    contentType,
    sizeBytes: Number(file.size || file.buffer?.length || 0),
  };
}

function adminId(admin = {}) {
  const id = cleanString(admin.id, 120);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    ? id
    : null;
}

function wordCount(text = '') {
  return cleanString(text, 100000).split(/\s+/).filter(Boolean).length;
}

function rowToPost(row) {
  if (!row) return null;
  if (!isXstreamBlogAuthor(row.author_name)) return null;
  const coverImageUrl = row.cover_image_url || '';
  const bodyText = row.body_text || stripHtml(row.body_html || '');
  const words = wordCount(bodyText);
  const tags = Array.isArray(row.tags) ? row.tags : [];
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary || '',
    category: row.category || 'Platform updates',
    tags,
    author: XSTREAM_BLOG_AUTHOR,
    authorName: XSTREAM_BLOG_AUTHOR,
    status: row.status || 'draft',
    bodyHtml: row.body_html || '',
    bodyText,
    coverImageUrl,
    coverImageAlt: row.cover_image_alt || '',
    imageUrl: coverImageUrl,
    imageAlt: row.cover_image_alt || '',
    videoUrl: row.video_url || '',
    videoTitle: row.video_title || '',
    seo: normalizeSeo(row.seo, {
      title: row.title,
      summary: row.summary,
      slug: row.slug,
      coverImageUrl,
    }),
    publishedAt: row.published_at,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    readingMinutes: Math.max(1, Math.ceil(words / 220)),
    wordCount: words,
    createdByEmail: row.created_by_email || null,
    updatedByEmail: row.updated_by_email || null,
  };
}

function normalizePayload(input = {}, requestedStatus = null) {
  const title = cleanString(input.title, 180);
  const slug = normalizeBlogSlug(input.slug || title, title);
  const summary = cleanString(input.summary || input.description, 500);
  const category = cleanString(input.category || 'Platform updates', 80);
  const bodyHtml = sanitizeBlogHtml(input.bodyHtml || input.contentHtml || '');
  const bodyText = stripHtml(bodyHtml);
  const coverImageUrl = normalizeUrl(input.coverImageUrl || input.imageUrl || input.cover_image_url);
  const videoUrl = normalizeUrl(input.videoUrl || input.video_url);
  const status = normalizeStatus(requestedStatus || input.status, 'draft');

  if (!title) {
    const err = new Error('Blog title is required.');
    err.status = 400;
    throw err;
  }
  if (status === 'published' && bodyText.split(/\s+/).filter(Boolean).length < 120) {
    const err = new Error('Published blog posts need at least 120 words of article content.');
    err.status = 400;
    throw err;
  }
  if (status === 'published' && !summary) {
    const err = new Error('Published blog posts need a summary.');
    err.status = 400;
    throw err;
  }

  return {
    slug,
    title,
    summary,
    category,
    tags: normalizeTags(input.tags),
    author_name: XSTREAM_BLOG_AUTHOR,
    status,
    body_html: bodyHtml,
    body_text: bodyText,
    cover_image_url: coverImageUrl,
    cover_image_alt: cleanString(input.coverImageAlt || input.imageAlt || input.cover_image_alt, 180),
    video_url: videoUrl,
    video_title: cleanString(input.videoTitle || input.video_title, 180),
    seo: normalizeSeo(input.seo, { title, summary, slug, coverImageUrl }),
  };
}

function selectFields() {
  return [
    'id',
    'slug',
    'title',
    'summary',
    'category',
    'tags',
    'author_name',
    'status',
    'body_html',
    'body_text',
    'cover_image_url',
    'cover_image_alt',
    'video_url',
    'video_title',
    'seo',
    'published_at',
    'archived_at',
    'created_at',
    'updated_at',
    'created_by_email',
    'updated_by_email',
  ].join(',');
}

export async function listPublishedBlogPosts({ limit = 24 } = {}) {
  assertConfigured();
  const { data, error } = await supabase
    .from(TABLE)
    .select(selectFields())
    .eq('status', 'published')
    .ilike('author_name', XSTREAM_AUTHOR_QUERY)
    .order('published_at', { ascending: false, nullsFirst: false })
    .order('updated_at', { ascending: false })
    .limit(Math.min(100, Math.max(1, Number(limit) || 24)));
  if (error) throw error;
  return { posts: (data || []).map(rowToPost).filter(Boolean), schemaReady: true };
}

export async function getPublishedBlogPost(slug) {
  assertConfigured();
  const { data, error } = await supabase
    .from(TABLE)
    .select(selectFields())
    .eq('slug', normalizeBlogSlug(slug))
    .eq('status', 'published')
    .ilike('author_name', XSTREAM_AUTHOR_QUERY)
    .maybeSingle();
  if (error) throw error;
  return rowToPost(data);
}

export async function listAdminBlogPosts(params = {}) {
  assertConfigured();
  const limit = Math.min(100, Math.max(1, Number(params.limit) || 50));
  const search = cleanString(params.search, 120).replace(/[(),]/g, ' ').replace(/\s+/g, ' ').trim();
  const status = normalizeStatus(params.status, '');
  let query = supabase
    .from(TABLE)
    .select(selectFields())
    .ilike('author_name', XSTREAM_AUTHOR_QUERY)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (status) query = query.eq('status', status);
  if (search) query = query.or(`title.ilike.%${search}%,summary.ilike.%${search}%,slug.ilike.%${search}%`);

  const { data, error } = await query;
  if (error) throw error;
  return { posts: (data || []).map(rowToPost).filter(Boolean), schemaReady: true };
}

export async function getAdminBlogPost(id) {
  assertConfigured();
  const { data, error } = await supabase
    .from(TABLE)
    .select(selectFields())
    .eq('id', cleanString(id, 120))
    .ilike('author_name', XSTREAM_AUTHOR_QUERY)
    .maybeSingle();
  if (error) throw error;
  return { post: rowToPost(data) };
}

export async function createBlogPost(input, admin = {}) {
  assertConfigured();
  const payload = normalizePayload(input);
  const now = new Date().toISOString();
  if (payload.status === 'published') payload.published_at = now;
  payload.created_by = adminId(admin);
  payload.updated_by = adminId(admin);
  payload.created_by_email = cleanString(admin.email, 180);
  payload.updated_by_email = cleanString(admin.email, 180);

  const { data, error } = await supabase
    .from(TABLE)
    .insert(payload)
    .select(selectFields())
    .single();
  if (error) throw error;
  return { post: rowToPost(data) };
}

export async function updateBlogPost(id, input, admin = {}, forcedStatus = null) {
  assertConfigured();
  const payload = normalizePayload(input, forcedStatus);
  const now = new Date().toISOString();
  if (payload.status === 'published') payload.published_at = input.publishedAt || now;
  if (payload.status === 'archived') payload.archived_at = now;
  if (payload.status !== 'archived') payload.archived_at = null;
  payload.updated_by = adminId(admin);
  payload.updated_by_email = cleanString(admin.email, 180);

  const { data, error } = await supabase
    .from(TABLE)
    .update(payload)
    .eq('id', cleanString(id, 120))
    .select(selectFields())
    .single();
  if (error) throw error;
  return { post: rowToPost(data) };
}

export async function publishBlogPost(id, input, admin = {}) {
  return updateBlogPost(id, input, admin, 'published');
}

export async function archiveBlogPost(id, admin = {}) {
  assertConfigured();
  const { data, error } = await supabase
    .from(TABLE)
    .update({
      status: 'archived',
      archived_at: new Date().toISOString(),
      updated_by: adminId(admin),
      updated_by_email: cleanString(admin.email, 180),
    })
    .eq('id', cleanString(id, 120))
    .select(selectFields())
    .single();
  if (error) throw error;
  return { post: rowToPost(data) };
}

export async function deleteBlogPost(id) {
  assertConfigured();
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq('id', cleanString(id, 120));
  if (error) throw error;
  return { deleted: true };
}
