import { createHash, randomUUID } from 'crypto';
import sanitizeHtml from 'sanitize-html';
import { supabase, isConfigured } from '../config/supabase.js';

const DOCUMENTS_TABLE = 'legal_documents';
const VERSIONS_TABLE = 'legal_document_versions';
const ACCEPTANCES_TABLE = 'legal_policy_acceptances';
const NOTIFICATIONS_TABLE = 'legal_policy_notifications';

const STATUSES = new Set(['draft', 'published', 'scheduled', 'archived']);
const AUDIENCES = new Set(['all', 'users', 'creators']);

export function isMissingLegalDbFeature(error) {
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
    const err = new Error('Database is not configured. Legal policy management is unavailable.');
    err.status = 503;
    throw err;
  }
}

function cleanString(value, max = 1000) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
}

function normalizeStatus(value, fallback = 'draft') {
  const status = cleanString(value, 24).toLowerCase();
  return STATUSES.has(status) ? status : fallback;
}

function normalizeAudience(value) {
  const audience = cleanString(value, 24).toLowerCase();
  return AUDIENCES.has(audience) ? audience : 'all';
}

export function normalizePolicySlug(value, fallback = '') {
  const source = cleanString(value || fallback, 160).toLowerCase();
  const slug = source
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140);
  return slug || `policy-${Date.now()}`;
}

function normalizeDocumentKey(value, fallback) {
  return normalizePolicySlug(value, fallback).replace(/-/g, '_').slice(0, 120);
}

function stripHtml(value) {
  return sanitizeHtml(String(value || ''), { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50000);
}

export function sanitizeLegalHtml(value) {
  return sanitizeHtml(String(value || ''), {
    allowedTags: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'br', 'hr',
      'strong', 'b', 'em', 'i', 'u', 's',
      'ul', 'ol', 'li',
      'blockquote', 'code', 'pre',
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
      'a', 'img',
      'span',
    ],
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
      table: ['summary'],
      th: ['scope', 'colspan', 'rowspan'],
      td: ['colspan', 'rowspan'],
      '*': ['id'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: {
      img: ['http', 'https', 'data'],
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
          alt: cleanString(attribs.alt || 'Policy image', 160),
          loading: 'lazy',
        },
      }),
    },
  }).trim();
}

function normalizeSeo(input = {}, fallback = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const fallbackSource = fallback && typeof fallback === 'object' ? fallback : {};
  return {
    pageTitle: cleanString(source.pageTitle ?? fallbackSource.pageTitle, 180),
    metaTitle: cleanString(source.metaTitle ?? fallbackSource.metaTitle, 180),
    metaDescription: cleanString(source.metaDescription ?? fallbackSource.metaDescription, 320),
    canonicalUrl: cleanString(source.canonicalUrl ?? fallbackSource.canonicalUrl, 500),
    ogTitle: cleanString(source.ogTitle ?? fallbackSource.ogTitle, 180),
    ogDescription: cleanString(source.ogDescription ?? fallbackSource.ogDescription, 320),
    ogImage: cleanString(source.ogImage ?? fallbackSource.ogImage, 500),
  };
}

function adminName(admin = {}) {
  return admin.name || admin.email || 'Admin';
}

function adminId(admin = {}) {
  const id = cleanString(admin.id, 120);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    ? id
    : null;
}

function rowToDocument(row) {
  if (!row) return null;
  const seo = row.seo && typeof row.seo === 'object' ? row.seo : {};
  return {
    id: row.id,
    documentKey: row.document_key,
    slug: row.slug,
    title: row.title,
    description: row.description || '',
    category: row.category || 'Legal',
    status: row.status,
    contentHtml: row.content_html || '',
    contentText: row.content_text || '',
    seo: normalizeSeo(seo),
    requireReacceptance: row.require_reacceptance === true,
    updateBannerEnabled: row.update_banner_enabled === true,
    updateSummary: row.update_summary || '',
    scheduledPublishAt: row.scheduled_publish_at || null,
    publishedAt: row.published_at || null,
    archivedAt: row.archived_at || null,
    currentVersionId: row.current_version_id || null,
    versionNumber: Number(row.version_number || 0),
    createdBy: row.created_by || null,
    createdByEmail: row.created_by_email || null,
    updatedBy: row.updated_by || null,
    updatedByEmail: row.updated_by_email || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToVersion(row) {
  if (!row) return null;
  const seo = row.seo && typeof row.seo === 'object' ? row.seo : {};
  return {
    id: row.id,
    documentId: row.document_id,
    versionNumber: Number(row.version_number || 0),
    status: row.status,
    title: row.title,
    slug: row.slug,
    description: row.description || '',
    category: row.category || 'Legal',
    contentHtml: row.content_html || '',
    contentText: row.content_text || '',
    seo: normalizeSeo(seo),
    requireReacceptance: row.require_reacceptance === true,
    updateBannerEnabled: row.update_banner_enabled === true,
    updateSummary: row.update_summary || '',
    scheduledPublishAt: row.scheduled_publish_at || null,
    publishedAt: row.published_at || null,
    changeNotes: row.change_notes || '',
    authorId: row.author_id || null,
    authorEmail: row.author_email || null,
    authorName: row.author_name || '',
    createdAt: row.created_at,
  };
}

function publicDocumentFromVersion(documentRow, versionRow) {
  const version = rowToVersion(versionRow);
  const document = rowToDocument(documentRow);
  if (!document || !version) return null;
  return {
    id: document.id,
    documentKey: document.documentKey,
    slug: version.slug,
    title: version.title,
    description: version.description,
    category: version.category,
    contentHtml: version.contentHtml,
    contentText: version.contentText,
    seo: version.seo,
    requireReacceptance: version.requireReacceptance,
    updateBannerEnabled: version.updateBannerEnabled,
    updateSummary: version.updateSummary,
    versionId: version.id,
    versionNumber: version.versionNumber,
    publishedAt: version.publishedAt || version.createdAt,
    updatedAt: document.updatedAt,
  };
}

async function publishDueScheduledDocuments() {
  if (!isConfigured() || !supabase) return;
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from(DOCUMENTS_TABLE)
    .select('*')
    .eq('status', 'scheduled')
    .not('current_version_id', 'is', null)
    .lte('scheduled_publish_at', now)
    .limit(25);

  if (error) {
    if (isMissingLegalDbFeature(error)) return;
    throw error;
  }

  for (const doc of data || []) {
    const { error: versionError } = await supabase
      .from(VERSIONS_TABLE)
      .update({ status: 'published', published_at: now })
      .eq('id', doc.current_version_id);
    if (versionError && !isMissingLegalDbFeature(versionError)) throw versionError;

    const { error: documentError } = await supabase
      .from(DOCUMENTS_TABLE)
      .update({ status: 'published', published_at: now, archived_at: null })
      .eq('id', doc.id);
    if (documentError && !isMissingLegalDbFeature(documentError)) throw documentError;

    if (doc.update_banner_enabled || doc.require_reacceptance) {
      await createPolicyNotification({
        document: doc,
        versionId: doc.current_version_id,
        versionNumber: Number(doc.version_number || 0),
        title: doc.title,
        message: doc.update_summary,
        audience: 'all',
        requireReacceptance: doc.require_reacceptance,
        bannerEnabled: doc.update_banner_enabled,
      }).catch(() => {});
    }
  }
}

async function getRawDocument(idOrKey) {
  assertConfigured();
  const value = cleanString(idOrKey, 180);
  if (!value) return null;

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  let query = supabase.from(DOCUMENTS_TABLE).select('*').limit(1);
  if (isUuid) query = query.eq('id', value);
  else query = query.or(`document_key.eq.${value},slug.eq.${value}`);

  const { data, error } = await query.maybeSingle();
  if (error) {
    if (isMissingLegalDbFeature(error)) {
      const err = new Error('Legal policy tables are missing. Run the legal policy CMS migration.');
      err.status = 501;
      err.tableMissing = true;
      throw err;
    }
    throw error;
  }
  return data || null;
}

function buildDocumentPayload(input = {}, existing = null, admin = {}, statusOverride = null) {
  const title = cleanString(input.title ?? existing?.title, 220);
  if (!title) {
    const err = new Error('Policy title is required.');
    err.status = 400;
    throw err;
  }

  const slug = normalizePolicySlug(input.slug ?? existing?.slug, title);
  const html = sanitizeLegalHtml(input.contentHtml ?? input.content_html ?? existing?.content_html ?? '');
  const text = stripHtml(input.contentText ?? input.content_text ?? html);
  if (!html || !text) {
    const err = new Error('Policy content is required.');
    err.status = 400;
    throw err;
  }

  const status = normalizeStatus(statusOverride || input.status || existing?.status || 'draft');
  const scheduledPublishAt = cleanString(input.scheduledPublishAt ?? input.scheduled_publish_at ?? existing?.scheduled_publish_at, 80) || null;
  const now = new Date().toISOString();

  return {
    document_key: normalizeDocumentKey(input.documentKey ?? input.document_key ?? existing?.document_key, slug),
    slug,
    title,
    description: cleanString(input.description ?? existing?.description, 500) || null,
    category: cleanString(input.category ?? existing?.category ?? 'Legal', 80) || 'Legal',
    status,
    content_html: html,
    content_text: text,
    seo: normalizeSeo(input.seo, existing?.seo || {
      pageTitle: `${title} | XstreamVideos`,
      metaTitle: title,
      metaDescription: cleanString(input.description, 300),
      canonicalUrl: `/${slug}`,
    }),
    require_reacceptance: input.requireReacceptance ?? input.require_reacceptance ?? existing?.require_reacceptance ?? false,
    update_banner_enabled: input.updateBannerEnabled ?? input.update_banner_enabled ?? existing?.update_banner_enabled ?? false,
    update_summary: cleanString(input.updateSummary ?? input.update_summary ?? existing?.update_summary, 500) || null,
    scheduled_publish_at: status === 'scheduled' ? scheduledPublishAt : null,
    published_at: status === 'published' ? now : (existing?.published_at || null),
    archived_at: status === 'archived' ? now : null,
    updated_by: adminId(admin),
    updated_by_email: admin.email || null,
  };
}

async function nextVersionNumber(documentId) {
  const { data, error } = await supabase
    .from(VERSIONS_TABLE)
    .select('version_number')
    .eq('document_id', documentId)
    .order('version_number', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    if (isMissingLegalDbFeature(error)) {
      const err = new Error('Legal policy version table is missing. Run the legal policy CMS migration.');
      err.status = 501;
      err.tableMissing = true;
      throw err;
    }
    throw error;
  }
  return Number(data?.version_number || 0) + 1;
}

async function createVersionFromDocument(documentRow, status, changeNotes, admin = {}) {
  const versionNumber = await nextVersionNumber(documentRow.id);
  const now = new Date().toISOString();
  const row = {
    id: randomUUID(),
    document_id: documentRow.id,
    version_number: versionNumber,
    status,
    title: documentRow.title,
    slug: documentRow.slug,
    description: documentRow.description || null,
    category: documentRow.category || 'Legal',
    content_html: documentRow.content_html || '',
    content_text: documentRow.content_text || stripHtml(documentRow.content_html || ''),
    seo: documentRow.seo || {},
    require_reacceptance: documentRow.require_reacceptance === true,
    update_banner_enabled: documentRow.update_banner_enabled === true,
    update_summary: documentRow.update_summary || null,
    scheduled_publish_at: status === 'scheduled' ? documentRow.scheduled_publish_at : null,
    published_at: status === 'published' ? now : null,
    change_notes: cleanString(changeNotes, 1000) || null,
    author_id: adminId(admin),
    author_email: admin.email || null,
    author_name: adminName(admin),
    created_at: now,
  };

  const { data, error } = await supabase
    .from(VERSIONS_TABLE)
    .insert(row)
    .select()
    .maybeSingle();
  if (error) throw error;
  return data || row;
}

async function createPolicyNotification({
  document,
  versionId,
  versionNumber,
  title,
  message,
  audience = 'all',
  requireReacceptance = false,
  bannerEnabled = false,
}) {
  if (!document?.id) return null;
  await supabase
    .from(NOTIFICATIONS_TABLE)
    .update({ active: false })
    .eq('document_key', document.document_key || document.documentKey)
    .eq('active', true);

  const row = {
    id: randomUUID(),
    document_id: document.id,
    version_id: versionId,
    document_key: document.document_key || document.documentKey,
    version_number: Number(versionNumber || 0),
    title: cleanString(title, 220) || 'Policy update',
    message: cleanString(message, 600) || 'A legal policy has been updated.',
    audience: normalizeAudience(audience),
    require_reacceptance: requireReacceptance === true,
    banner_enabled: bannerEnabled === true,
    active: true,
    created_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from(NOTIFICATIONS_TABLE)
    .insert(row)
    .select()
    .maybeSingle();
  if (error && !isMissingLegalDbFeature(error)) throw error;
  return data || row;
}

async function saveDocument(input = {}, admin = {}, statusOverride = null, idOrKey = null) {
  assertConfigured();
  const existing = idOrKey ? await getRawDocument(idOrKey) : null;
  const payload = buildDocumentPayload(input, existing, admin, statusOverride);
  const status = payload.status;
  let documentRow;

  if (existing?.id) {
    const { data, error } = await supabase
      .from(DOCUMENTS_TABLE)
      .update(payload)
      .eq('id', existing.id)
      .select()
      .maybeSingle();
    if (error) throw error;
    documentRow = data;
  } else {
    const row = {
      id: randomUUID(),
      ...payload,
      created_by: adminId(admin),
      created_by_email: admin.email || null,
      created_at: new Date().toISOString(),
    };
    const { data, error } = await supabase
      .from(DOCUMENTS_TABLE)
      .insert(row)
      .select()
      .maybeSingle();
    if (error) throw error;
    documentRow = data;
  }

  const version = await createVersionFromDocument(documentRow, status, input.changeNotes || input.change_notes, admin);
  const update = {
    current_version_id: version.id,
    version_number: version.version_number,
  };
  if (status === 'published') update.published_at = version.published_at;
  if (status !== 'archived') update.archived_at = null;

  const { data: updated, error: updateError } = await supabase
    .from(DOCUMENTS_TABLE)
    .update(update)
    .eq('id', documentRow.id)
    .select()
    .maybeSingle();
  if (updateError) throw updateError;

  if (status === 'published' && (updated.update_banner_enabled || updated.require_reacceptance)) {
    await createPolicyNotification({
      document: updated,
      versionId: version.id,
      versionNumber: version.version_number,
      title: updated.title,
      message: updated.update_summary,
      audience: input.audience,
      requireReacceptance: updated.require_reacceptance,
      bannerEnabled: updated.update_banner_enabled,
    });
  }

  return {
    document: rowToDocument(updated),
    version: rowToVersion(version),
  };
}

export async function listAdminLegalDocuments(filters = {}) {
  assertConfigured();
  await publishDueScheduledDocuments();

  const status = normalizeStatus(filters.status, '');
  const search = cleanString(filters.search, 120);
  const category = cleanString(filters.category, 80);
  const author = cleanString(filters.author, 120);
  const sort = cleanString(filters.sort || 'updated_at', 40);
  const direction = String(filters.direction || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
  const limit = Math.min(Math.max(Number(filters.limit || 100), 1), 250);

  let query = supabase.from(DOCUMENTS_TABLE).select('*');
  if (status) query = query.eq('status', status);
  if (category) query = query.eq('category', category);
  if (author) query = query.ilike('updated_by_email', `%${author}%`);
  if (search) {
    const term = search.replace(/[%(),]/g, '');
    query = query.or(`title.ilike.%${term}%,slug.ilike.%${term}%,document_key.ilike.%${term}%,description.ilike.%${term}%`);
  }

  const sortColumn = ['title', 'status', 'published_at', 'created_at', 'updated_at', 'category'].includes(sort) ? sort : 'updated_at';
  const { data, error } = await query.order(sortColumn, { ascending: direction === 'asc' }).limit(limit);
  if (error) {
    if (isMissingLegalDbFeature(error)) {
      return { documents: [], schemaReady: false, tableMissing: true };
    }
    throw error;
  }

  return { documents: (data || []).map(rowToDocument), schemaReady: true, tableMissing: false };
}

export async function getAdminLegalDocument(idOrKey) {
  const row = await getRawDocument(idOrKey);
  if (!row) {
    const err = new Error('Legal policy not found.');
    err.status = 404;
    throw err;
  }
  const versions = await listLegalDocumentVersions(row.id);
  return { document: rowToDocument(row), versions };
}

export async function createLegalDocument(input, admin) {
  return saveDocument(input, admin, normalizeStatus(input?.status || 'draft'), null);
}

export async function updateLegalDocument(idOrKey, input, admin) {
  return saveDocument(input, admin, normalizeStatus(input?.status || 'draft'), idOrKey);
}

export async function publishLegalDocument(idOrKey, input, admin) {
  const existing = await getRawDocument(idOrKey);
  if (!existing) {
    const err = new Error('Legal policy not found.');
    err.status = 404;
    throw err;
  }
  return saveDocument({ ...rowToDocument(existing), ...input }, admin, 'published', existing.id);
}

export async function archiveLegalDocument(idOrKey, input = {}, admin = {}) {
  const existing = await getRawDocument(idOrKey);
  if (!existing) {
    const err = new Error('Legal policy not found.');
    err.status = 404;
    throw err;
  }
  return saveDocument({ ...rowToDocument(existing), ...input, changeNotes: input.changeNotes || 'Archived policy.' }, admin, 'archived', existing.id);
}

export async function deleteLegalDocument(idOrKey) {
  assertConfigured();
  const existing = await getRawDocument(idOrKey);
  if (!existing) return { deleted: false };
  const { error } = await supabase.from(DOCUMENTS_TABLE).delete().eq('id', existing.id);
  if (error) throw error;
  return { deleted: true };
}

export async function listLegalDocumentVersions(documentId) {
  assertConfigured();
  const { data, error } = await supabase
    .from(VERSIONS_TABLE)
    .select('*')
    .eq('document_id', documentId)
    .order('version_number', { ascending: false })
    .limit(100);
  if (error) {
    if (isMissingLegalDbFeature(error)) return [];
    throw error;
  }
  return (data || []).map(rowToVersion);
}

export async function restoreLegalDocumentVersion(documentId, versionId, admin = {}) {
  assertConfigured();
  const { data: version, error } = await supabase
    .from(VERSIONS_TABLE)
    .select('*')
    .eq('document_id', documentId)
    .eq('id', versionId)
    .maybeSingle();
  if (error) throw error;
  if (!version) {
    const err = new Error('Version not found.');
    err.status = 404;
    throw err;
  }

  return saveDocument({
    documentKey: version.document_key,
    slug: version.slug,
    title: version.title,
    description: version.description,
    category: version.category,
    contentHtml: version.content_html,
    seo: version.seo,
    requireReacceptance: version.require_reacceptance,
    updateBannerEnabled: version.update_banner_enabled,
    updateSummary: version.update_summary,
    changeNotes: `Restored from version ${version.version_number}.`,
  }, admin, 'draft', documentId);
}

export async function compareLegalDocumentVersions(documentId, leftVersionId, rightVersionId) {
  assertConfigured();
  const ids = [leftVersionId, rightVersionId].filter(Boolean);
  if (ids.length !== 2) {
    const err = new Error('Choose two versions to compare.');
    err.status = 400;
    throw err;
  }

  const { data, error } = await supabase
    .from(VERSIONS_TABLE)
    .select('*')
    .eq('document_id', documentId)
    .in('id', ids);
  if (error) throw error;
  const versions = (data || []).map(rowToVersion);
  if (versions.length !== 2) {
    const err = new Error('One or more selected versions could not be found.');
    err.status = 404;
    throw err;
  }

  const [left, right] = ids.map((id) => versions.find((version) => version.id === id));
  const fields = ['title', 'slug', 'description', 'category', 'status', 'contentText', 'requireReacceptance', 'updateBannerEnabled', 'updateSummary'];
  const changedFields = fields.filter((field) => JSON.stringify(left?.[field]) !== JSON.stringify(right?.[field]));
  const seoChanged = JSON.stringify(left?.seo || {}) !== JSON.stringify(right?.seo || {});
  if (seoChanged) changedFields.push('seo');

  return { left, right, changedFields };
}

async function getPublishedVersionForDocument(documentRow) {
  const { data, error } = await supabase
    .from(VERSIONS_TABLE)
    .select('*')
    .eq('document_id', documentRow.id)
    .eq('status', 'published')
    .order('version_number', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function getPublishedLegalDocument(slugOrKey) {
  assertConfigured();
  await publishDueScheduledDocuments();
  const value = cleanString(slugOrKey, 180);
  if (!value) return null;

  let documentRow = null;
  try {
    documentRow = await getRawDocument(value);
  } catch (err) {
    if (!isMissingLegalDbFeature(err)) throw err;
  }

  if (documentRow?.status === 'archived') return null;
  if (documentRow) {
    const version = await getPublishedVersionForDocument(documentRow);
    return version ? publicDocumentFromVersion(documentRow, version) : null;
  }

  const { data: versionBySlug, error: versionError } = await supabase
    .from(VERSIONS_TABLE)
    .select('*')
    .eq('slug', value)
    .eq('status', 'published')
    .order('version_number', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (versionError) {
    if (isMissingLegalDbFeature(versionError)) {
      const err = new Error('Legal policy tables are missing. Run the legal policy CMS migration.');
      err.status = 501;
      err.tableMissing = true;
      throw err;
    }
    throw versionError;
  }
  if (!versionBySlug?.document_id) return null;

  const { data: versionDocument, error: documentError } = await supabase
    .from(DOCUMENTS_TABLE)
    .select('*')
    .eq('id', versionBySlug.document_id)
    .maybeSingle();
  if (documentError) throw documentError;
  if (!versionDocument || versionDocument.status === 'archived') return null;
  return publicDocumentFromVersion(versionDocument, versionBySlug);
}

export async function listPublishedLegalDocuments() {
  assertConfigured();
  await publishDueScheduledDocuments();

  const { data: docs, error } = await supabase
    .from(DOCUMENTS_TABLE)
    .select('*')
    .neq('status', 'archived')
    .order('title', { ascending: true });
  if (error) {
    if (isMissingLegalDbFeature(error)) return { documents: [], schemaReady: false };
    throw error;
  }

  const documents = [];
  for (const doc of docs || []) {
    const version = await getPublishedVersionForDocument(doc);
    if (version) documents.push(publicDocumentFromVersion(doc, version));
  }

  return { documents, schemaReady: true };
}

export async function listActiveLegalNotifications() {
  assertConfigured();
  await publishDueScheduledDocuments();
  const { data, error } = await supabase
    .from(NOTIFICATIONS_TABLE)
    .select('id, document_id, version_id, document_key, version_number, title, message, audience, require_reacceptance, banner_enabled, created_at')
    .eq('active', true)
    .eq('banner_enabled', true)
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) {
    if (isMissingLegalDbFeature(error)) return { notifications: [], schemaReady: false };
    throw error;
  }
  return {
    schemaReady: true,
    notifications: (data || []).map((row) => ({
      id: row.id,
      documentId: row.document_id,
      versionId: row.version_id,
      documentKey: row.document_key,
      versionNumber: Number(row.version_number || 0),
      title: row.title,
      message: row.message || '',
      audience: row.audience || 'all',
      requireReacceptance: row.require_reacceptance === true,
      bannerEnabled: row.banner_enabled === true,
      createdAt: row.created_at,
    })),
  };
}

export async function recordLegalAcceptance({
  documentKey,
  slug,
  userId,
  sessionId,
  ip,
  userAgent,
}) {
  assertConfigured();
  const document = await getPublishedLegalDocument(documentKey || slug);
  if (!document) {
    const err = new Error('Published policy not found.');
    err.status = 404;
    throw err;
  }
  const uid = cleanString(userId, 180);
  if (!uid) {
    const err = new Error('A user session is required to accept a policy.');
    err.status = 401;
    throw err;
  }

  const ipHash = ip
    ? createHash('sha256')
      .update(`${process.env.ANALYTICS_IP_SALT || process.env.JWT_SECRET || 'xstream'}:${ip}`)
      .digest('hex')
    : null;
  const deviceInfo = {
    userAgent: cleanString(userAgent, 600),
  };
  const row = {
    id: randomUUID(),
    document_id: document.id,
    version_id: document.versionId,
    document_key: document.documentKey,
    version_number: document.versionNumber,
    user_id: uid,
    session_id: cleanString(sessionId, 180) || null,
    ip_hash: ipHash,
    device_info: deviceInfo,
    accepted_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from(ACCEPTANCES_TABLE)
    .upsert(row, { onConflict: 'document_key,version_number,user_id' })
    .select()
    .maybeSingle();
  if (error) throw error;
  return {
    accepted: true,
    acceptance: {
      id: data?.id || row.id,
      documentKey: row.document_key,
      versionNumber: row.version_number,
      userId: row.user_id,
      acceptedAt: data?.accepted_at || row.accepted_at,
    },
  };
}
