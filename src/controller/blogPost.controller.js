import { logAdminAction } from '../services/adminAudit.service.js';
import {
  archiveBlogPost,
  createBlogPost,
  deleteBlogPost,
  getAdminBlogPost,
  getPublishedBlogPost,
  isMissingBlogDbFeature,
  listAdminBlogPosts,
  listPublishedBlogPosts,
  publishBlogPost,
  updateBlogPost,
  uploadBlogPostImage as uploadBlogPostImageAsset,
} from '../services/blogPost.service.js';

function handleError(res, err) {
  const status = err?.status || (isMissingBlogDbFeature(err) ? 501 : 500);
  return res.status(status).json({
    success: false,
    message: err?.message || 'Request failed.',
    tableMissing: err?.tableMissing || isMissingBlogDbFeature(err) || undefined,
  });
}

async function audit(req, action, targetId, details = {}) {
  try {
    await logAdminAction(req, {
      action,
      targetType: 'blog_post',
      targetId,
      details,
    });
  } catch {
    // Audit writes are useful, but they should not block editorial work.
  }
}

export async function listPublicBlogPosts(req, res) {
  try {
    const result = await listPublishedBlogPosts({ limit: req.query.limit });
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    return res.json({ success: true, ...result });
  } catch (err) {
    return handleError(res, err);
  }
}

export async function getPublicBlogPost(req, res) {
  try {
    const post = await getPublishedBlogPost(req.params.slug);
    if (!post) return res.status(404).json({ success: false, message: 'Blog post not found.' });
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    return res.json({ success: true, post });
  } catch (err) {
    return handleError(res, err);
  }
}

export async function listAdminBlogPostEntries(req, res) {
  try {
    const result = await listAdminBlogPosts(req.query || {});
    return res.json({ success: true, ...result });
  } catch (err) {
    return handleError(res, err);
  }
}

export async function getAdminBlogPostEntry(req, res) {
  try {
    const result = await getAdminBlogPost(req.params.id);
    if (!result.post) return res.status(404).json({ success: false, message: 'Blog post not found.' });
    return res.json({ success: true, ...result });
  } catch (err) {
    return handleError(res, err);
  }
}

export async function createAdminBlogPostEntry(req, res) {
  try {
    const result = await createBlogPost(req.body || {}, req.admin || {});
    await audit(req, 'Blog post created', result.post?.id, { slug: result.post?.slug, status: result.post?.status });
    return res.status(201).json({ success: true, message: 'Blog post created.', ...result });
  } catch (err) {
    return handleError(res, err);
  }
}

export async function uploadAdminBlogPostImage(req, res) {
  try {
    const image = await uploadBlogPostImageAsset(req.file, req.admin || {});
    await audit(req, 'Blog image uploaded', image.path, {
      bucket: image.bucket,
      fileName: image.fileName,
      sizeBytes: image.sizeBytes,
    });
    return res.status(201).json({ success: true, image });
  } catch (err) {
    return handleError(res, err);
  }
}

export async function updateAdminBlogPostEntry(req, res) {
  try {
    const result = await updateBlogPost(req.params.id, req.body || {}, req.admin || {});
    await audit(req, 'Blog post saved', result.post?.id, { slug: result.post?.slug, status: result.post?.status });
    return res.json({ success: true, message: 'Blog post saved.', ...result });
  } catch (err) {
    return handleError(res, err);
  }
}

export async function publishAdminBlogPostEntry(req, res) {
  try {
    const result = await publishBlogPost(req.params.id, req.body || {}, req.admin || {});
    await audit(req, 'Blog post published', result.post?.id, { slug: result.post?.slug });
    return res.json({ success: true, message: 'Blog post published.', ...result });
  } catch (err) {
    return handleError(res, err);
  }
}

export async function archiveAdminBlogPostEntry(req, res) {
  try {
    const result = await archiveBlogPost(req.params.id, req.admin || {});
    await audit(req, 'Blog post archived', result.post?.id, { slug: result.post?.slug });
    return res.json({ success: true, message: 'Blog post archived.', ...result });
  } catch (err) {
    return handleError(res, err);
  }
}

export async function deleteAdminBlogPostEntry(req, res) {
  try {
    const result = await deleteBlogPost(req.params.id);
    await audit(req, 'Blog post deleted', req.params.id);
    return res.json({ success: true, message: 'Blog post deleted.', ...result });
  } catch (err) {
    return handleError(res, err);
  }
}
