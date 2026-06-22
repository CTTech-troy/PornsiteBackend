import { resolveUidFromBearerToken } from '../utils/sessionToken.js';
import { logAdminAction } from '../services/adminAudit.service.js';
import {
  archiveLegalDocument,
  compareLegalDocumentVersions,
  createLegalDocument,
  deleteLegalDocument,
  getAdminLegalDocument,
  getPublishedLegalDocument,
  isMissingLegalDbFeature,
  listActiveLegalNotifications,
  listAdminLegalDocuments,
  listPublishedLegalDocuments,
  publishLegalDocument,
  recordLegalAcceptance,
  restoreLegalDocumentVersion,
  updateLegalDocument,
} from '../services/legalDocument.service.js';

function handleError(res, err) {
  const status = err?.status || (isMissingLegalDbFeature(err) ? 501 : 500);
  return res.status(status).json({
    success: false,
    message: err?.message || 'Request failed.',
    tableMissing: err?.tableMissing || isMissingLegalDbFeature(err) || undefined,
  });
}

function bearerToken(req) {
  const header = String(req.headers?.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function clientIp(req) {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || '';
}

async function audit(req, action, targetId, details = {}) {
  try {
    await logAdminAction(req, {
      action,
      targetType: 'legal_policy',
      targetId,
      details,
    });
  } catch {
    /* audit is optional */
  }
}

export async function listAdminLegalPolicies(req, res) {
  try {
    const result = await listAdminLegalDocuments(req.query || {});
    return res.json({ success: true, ...result });
  } catch (err) {
    return handleError(res, err);
  }
}

export async function getAdminLegalPolicy(req, res) {
  try {
    const result = await getAdminLegalDocument(req.params.id);
    return res.json({ success: true, ...result });
  } catch (err) {
    return handleError(res, err);
  }
}

export async function createAdminLegalPolicy(req, res) {
  try {
    const result = await createLegalDocument(req.body || {}, req.admin || {});
    await audit(req, 'Legal policy created', result.document?.id, { slug: result.document?.slug, status: result.document?.status });
    return res.status(201).json({ success: true, message: 'Legal policy created.', ...result });
  } catch (err) {
    return handleError(res, err);
  }
}

export async function updateAdminLegalPolicy(req, res) {
  try {
    const result = await updateLegalDocument(req.params.id, req.body || {}, req.admin || {});
    await audit(req, 'Legal policy draft saved', result.document?.id, { slug: result.document?.slug, status: result.document?.status });
    return res.json({ success: true, message: 'Legal policy saved.', ...result });
  } catch (err) {
    return handleError(res, err);
  }
}

export async function publishAdminLegalPolicy(req, res) {
  try {
    const result = await publishLegalDocument(req.params.id, req.body || {}, req.admin || {});
    await audit(req, 'Legal policy published', result.document?.id, {
      slug: result.document?.slug,
      versionNumber: result.version?.versionNumber,
      requireReacceptance: result.document?.requireReacceptance,
    });
    return res.json({ success: true, message: 'Legal policy published.', ...result });
  } catch (err) {
    return handleError(res, err);
  }
}

export async function archiveAdminLegalPolicy(req, res) {
  try {
    const result = await archiveLegalDocument(req.params.id, req.body || {}, req.admin || {});
    await audit(req, 'Legal policy archived', result.document?.id, { slug: result.document?.slug });
    return res.json({ success: true, message: 'Legal policy archived.', ...result });
  } catch (err) {
    return handleError(res, err);
  }
}

export async function deleteAdminLegalPolicy(req, res) {
  try {
    const result = await deleteLegalDocument(req.params.id);
    await audit(req, 'Legal policy deleted', req.params.id);
    return res.json({ success: true, message: result.deleted ? 'Legal policy deleted.' : 'Legal policy already removed.', ...result });
  } catch (err) {
    return handleError(res, err);
  }
}

export async function restoreAdminLegalPolicyVersion(req, res) {
  try {
    const result = await restoreLegalDocumentVersion(req.params.id, req.params.versionId, req.admin || {});
    await audit(req, 'Legal policy version restored', req.params.id, { versionId: req.params.versionId });
    return res.json({ success: true, message: 'Version restored as a draft.', ...result });
  } catch (err) {
    return handleError(res, err);
  }
}

export async function compareAdminLegalPolicyVersions(req, res) {
  try {
    const result = await compareLegalDocumentVersions(req.params.id, req.query.left || req.body?.left, req.query.right || req.body?.right);
    return res.json({ success: true, ...result });
  } catch (err) {
    return handleError(res, err);
  }
}

export async function listPublicLegalPolicies(_req, res) {
  try {
    const result = await listPublishedLegalDocuments();
    return res.json({ success: true, ...result });
  } catch (err) {
    return handleError(res, err);
  }
}

export async function getPublicLegalPolicy(req, res) {
  try {
    const document = await getPublishedLegalDocument(req.params.slug);
    if (!document) return res.status(404).json({ success: false, message: 'Legal policy not found.' });
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    return res.json({ success: true, document });
  } catch (err) {
    return handleError(res, err);
  }
}

export async function getPublicLegalUpdates(_req, res) {
  try {
    const result = await listActiveLegalNotifications();
    res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
    return res.json({ success: true, ...result });
  } catch (err) {
    return handleError(res, err);
  }
}

export async function acceptPublicLegalPolicy(req, res) {
  try {
    const token = bearerToken(req);
    const uidFromToken = token ? await resolveUidFromBearerToken(token) : null;
    const result = await recordLegalAcceptance({
      documentKey: req.params.slug || req.body?.documentKey,
      slug: req.params.slug || req.body?.slug,
      userId: uidFromToken || req.body?.userId,
      sessionId: req.body?.sessionId,
      ip: clientIp(req),
      userAgent: req.headers?.['user-agent'] || '',
    });
    return res.json({ success: true, message: 'Policy acceptance recorded.', ...result });
  } catch (err) {
    return handleError(res, err);
  }
}
