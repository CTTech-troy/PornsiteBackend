import { randomUUID } from 'crypto';
import { supabase, isConfigured } from '../config/supabase.js';
import { getEmailTemplateMeta } from './emailTemplates.js';
import { safeUrl } from './emailRenderer.js';

const TABLE_NAME = 'email_template_versions';

const FIELD_LIMITS = {
  subject: 180,
  preheader: 220,
  eyebrow: 80,
  heading: 180,
  intro: 2000,
  bodyMarkdown: 12000,
  ctaLabel: 80,
  ctaUrl: 500,
  footerNote: 500,
};

function isMissingDbFeature(error) {
  const message = String(error?.message || '');
  return (
    error?.code === '42P01' ||
    error?.code === '42703' ||
    error?.code === 'PGRST200' ||
    /schema cache|does not exist/i.test(message)
  );
}

function assertKnownTemplate(templateKey) {
  const key = String(templateKey || '').trim();
  if (!getEmailTemplateMeta(key)) {
    const err = new Error(`Unknown email template: ${key || '(empty)'}`);
    err.status = 404;
    throw err;
  }
  return key;
}

function cleanString(value, maxLength) {
  const text = String(value || '').replace(/\r\n/g, '\n').trim();
  return text.slice(0, maxLength);
}

export function normalizeTemplateOverrides(input = {}) {
  const out = {};
  const source = input && typeof input === 'object' ? input : {};

  for (const [field, maxLength] of Object.entries(FIELD_LIMITS)) {
    if (source[field] === undefined || source[field] === null) continue;
    const value = cleanString(source[field], maxLength);
    if (!value) continue;
    if (field === 'ctaUrl') {
      const href = safeUrl(value, '');
      if (href) out.ctaUrl = href;
      continue;
    }
    out[field] = value;
  }

  return out;
}

export async function getActiveTemplateOverride(templateKey) {
  if (!isConfigured() || !supabase) return null;
  const key = assertKnownTemplate(templateKey);
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .select('id, template_key, version_label, overrides, created_at, created_by, created_by_email')
    .eq('template_key', key)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    if (isMissingDbFeature(error)) return null;
    throw error;
  }
  return data || null;
}

export async function listTemplateVersions(templateKey, limit = 20) {
  if (!isConfigured() || !supabase) return { versions: [], tableMissing: true };
  const key = assertKnownTemplate(templateKey);
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .select('id, template_key, version_label, is_active, created_at, created_by, created_by_email, overrides')
    .eq('template_key', key)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    if (isMissingDbFeature(error)) return { versions: [], tableMissing: true };
    throw error;
  }
  return { versions: data || [], tableMissing: false };
}

export async function saveTemplateVersion(templateKey, overrides, admin = {}) {
  if (!isConfigured() || !supabase) {
    const err = new Error('Database is not configured. Template versions cannot be saved.');
    err.status = 503;
    throw err;
  }

  const key = assertKnownTemplate(templateKey);
  const cleanOverrides = normalizeTemplateOverrides(overrides);
  if (!Object.keys(cleanOverrides).length) {
    const err = new Error('Add at least one template override before saving.');
    err.status = 400;
    throw err;
  }

  const now = new Date().toISOString();
  const adminName = admin?.name || admin?.email || 'Admin';
  const row = {
    id: randomUUID(),
    template_key: key,
    version_label: `v${now.replace(/[-:T.Z]/g, '').slice(0, 12)}`,
    overrides: cleanOverrides,
    is_active: true,
    created_by: admin?.id || null,
    created_by_email: admin?.email || null,
    created_by_name: adminName,
    created_at: now,
  };

  const deactivate = await supabase
    .from(TABLE_NAME)
    .update({ is_active: false })
    .eq('template_key', key)
    .eq('is_active', true);

  if (deactivate.error && !isMissingDbFeature(deactivate.error)) throw deactivate.error;
  if (deactivate.error && isMissingDbFeature(deactivate.error)) {
    const err = new Error('Email template version table is missing. Run the email template migration.');
    err.status = 501;
    err.tableMissing = true;
    throw err;
  }

  const { data, error } = await supabase
    .from(TABLE_NAME)
    .insert(row)
    .select()
    .maybeSingle();

  if (error) {
    if (isMissingDbFeature(error)) {
      const err = new Error('Email template version table is missing. Run the email template migration.');
      err.status = 501;
      err.tableMissing = true;
      throw err;
    }
    throw error;
  }

  return data || row;
}

export async function listActiveTemplateOverrides(templateKeys = []) {
  if (!isConfigured() || !supabase || !templateKeys.length) return new Map();
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .select('id, template_key, version_label, overrides, created_at, created_by_email')
    .in('template_key', templateKeys)
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  if (error) {
    if (isMissingDbFeature(error)) return new Map();
    throw error;
  }

  const map = new Map();
  for (const row of data || []) {
    if (!map.has(row.template_key)) map.set(row.template_key, row);
  }
  return map;
}
