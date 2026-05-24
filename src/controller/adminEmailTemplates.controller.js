import { isValidEmail, safeUrl } from '../services/emailRenderer.js';
import {
  getEmailTemplateMeta,
  listEmailTemplates,
  renderEmailTemplate,
  sampleDataForTemplate,
} from '../services/emailTemplates.js';
import {
  getActiveTemplateOverride,
  listActiveTemplateOverrides,
  listTemplateVersions,
  normalizeTemplateOverrides,
  saveTemplateVersion,
} from '../services/emailTemplateAdmin.service.js';
import {
  renderTemplateEmail,
  sendEmailTemplateTest,
} from '../services/emailService.js';
import { logAction as writeAuditAction } from '../services/adminAudit.service.js';

function parseVariables(input, templateKey) {
  if (!input) return sampleDataForTemplate(templateKey);
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : sampleDataForTemplate(templateKey);
    } catch {
      const err = new Error('Variables must be valid JSON.');
      err.status = 400;
      throw err;
    }
  }
  if (typeof input === 'object' && !Array.isArray(input)) return input;
  return sampleDataForTemplate(templateKey);
}

function mergeOverrides(savedRecord, draftOverrides = {}) {
  return {
    ...normalizeTemplateOverrides(savedRecord?.overrides || {}),
    ...normalizeTemplateOverrides(draftOverrides),
  };
}

function publicVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    templateKey: row.template_key,
    versionLabel: row.version_label,
    active: row.is_active === true,
    createdAt: row.created_at,
    createdBy: row.created_by_name || row.created_by_email || row.created_by || null,
    overrides: normalizeTemplateOverrides(row.overrides || {}),
  };
}

async function audit(req, action, templateKey, details = {}) {
  try {
    await writeAuditAction(
      req.admin?.id,
      req.admin?.name || req.admin?.email,
      action,
      'email_template',
      templateKey,
      details,
    );
  } catch {
    /* audit is optional */
  }
}

export async function listAdminEmailTemplates(_req, res) {
  try {
    const templates = listEmailTemplates();
    const activeMap = await listActiveTemplateOverrides(templates.map((template) => template.key));
    return res.json({
      success: true,
      templates: templates.map((template) => {
        const active = activeMap.get(template.key);
        return {
          ...template,
          activeVersion: publicVersion(active),
          hasOverride: Boolean(active?.overrides && Object.keys(active.overrides).length),
        };
      }),
    });
  } catch (err) {
    return res.status(err.status || 500).json({ success: false, message: err.message });
  }
}

export async function getAdminEmailTemplate(req, res) {
  try {
    const key = String(req.params.key || '').trim();
    const meta = getEmailTemplateMeta(key);
    if (!meta) return res.status(404).json({ success: false, message: 'Template not found.' });

    const [active, versionsResult] = await Promise.all([
      getActiveTemplateOverride(key),
      listTemplateVersions(key),
    ]);
    const variables = sampleDataForTemplate(key);
    const rendered = await renderTemplateEmail(key, variables);

    return res.json({
      success: true,
      template: {
        ...meta,
        sampleData: variables,
        activeVersion: publicVersion(active),
        versions: versionsResult.versions.map(publicVersion),
        tableMissing: versionsResult.tableMissing,
      },
      rendered,
    });
  } catch (err) {
    return res.status(err.status || 500).json({ success: false, message: err.message, tableMissing: err.tableMissing || undefined });
  }
}

export async function previewAdminEmailTemplate(req, res) {
  try {
    const key = String(req.params.key || req.body?.templateKey || '').trim();
    const meta = getEmailTemplateMeta(key);
    if (!meta) return res.status(404).json({ success: false, message: 'Template not found.' });

    const variables = parseVariables(req.body?.variables, key);
    const draftOverrides = normalizeTemplateOverrides(req.body?.overrides || {});
    const useSaved = req.body?.useSavedOverrides !== false;
    const active = useSaved ? await getActiveTemplateOverride(key) : null;
    const overrides = mergeOverrides(active, draftOverrides);
    const rendered = renderEmailTemplate(key, variables, { overrides });

    return res.json({
      success: true,
      template: meta,
      overrides,
      rendered,
    });
  } catch (err) {
    return res.status(err.status || 500).json({ success: false, message: err.message });
  }
}

export async function saveAdminEmailTemplate(req, res) {
  try {
    const key = String(req.params.key || req.body?.templateKey || '').trim();
    const meta = getEmailTemplateMeta(key);
    if (!meta) return res.status(404).json({ success: false, message: 'Template not found.' });

    const overrides = normalizeTemplateOverrides(req.body?.overrides || {});
    if (overrides.ctaUrl) overrides.ctaUrl = safeUrl(overrides.ctaUrl, '');
    const saved = await saveTemplateVersion(key, overrides, req.admin);
    await audit(req, 'Email template version saved', key, { fields: Object.keys(overrides) });

    return res.json({
      success: true,
      message: 'Email template version saved.',
      version: publicVersion(saved),
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      success: false,
      message: err.message,
      tableMissing: err.tableMissing || undefined,
    });
  }
}

const MESSAGE_FIELD_BY_TEMPLATE = {
  content_removal_feedback: 'message',
  content_removal_status: 'message',
  creator_application_rejected: 'reason',
  creator_application_info_requested: 'reason',
  creator_application_approved: 'reason',
  account_deletion: 'reason',
  withdrawal_rejected: 'reason',
  withdrawal_receipt_rejected: 'reason',
  payment_failure: 'reason',
  notification: 'message',
};

export async function previewAdminMessageEmail(req, res) {
  try {
    const templateKey = String(req.body?.templateKey || req.params.key || '').trim();
    const meta = getEmailTemplateMeta(templateKey);
    if (!meta) return res.status(404).json({ success: false, message: 'Template not found.' });

    const field = String(req.body?.messageField || MESSAGE_FIELD_BY_TEMPLATE[templateKey] || 'message').trim();
    const message = String(req.body?.message ?? '');
    const variables = {
      ...parseVariables(req.body?.variables, templateKey),
      [field]: message,
    };
    const draftOverrides = normalizeTemplateOverrides(req.body?.overrides || {});
    const useSaved = req.body?.useSavedOverrides !== false;
    const active = useSaved ? await getActiveTemplateOverride(templateKey) : null;
    const overrides = mergeOverrides(active, draftOverrides);
    const rendered = renderEmailTemplate(templateKey, variables, { overrides });

    return res.json({
      success: true,
      template: meta,
      rendered,
      messageField: field,
    });
  } catch (err) {
    return res.status(err.status || 500).json({ success: false, message: err.message });
  }
}

export async function sendAdminEmailTemplateTest(req, res) {
  try {
    const key = String(req.params.key || req.body?.templateKey || '').trim();
    const meta = getEmailTemplateMeta(key);
    if (!meta) return res.status(404).json({ success: false, message: 'Template not found.' });

    const to = String(req.body?.to || '').trim();
    if (!isValidEmail(to)) return res.status(400).json({ success: false, message: 'Enter a valid test recipient email.' });

    const variables = parseVariables(req.body?.variables, key);
    const draftOverrides = normalizeTemplateOverrides(req.body?.overrides || {});
    const active = req.body?.useSavedOverrides === false ? null : await getActiveTemplateOverride(key);
    const overrides = mergeOverrides(active, draftOverrides);
    const result = await sendEmailTemplateTest({ to, templateKey: key, variables, overrides });
    await audit(req, 'Email template test sent', key, { to });

    return res.json({
      success: true,
      message: 'Test email sent.',
      result,
    });
  } catch (err) {
    return res.status(err.status || 500).json({ success: false, message: err.message });
  }
}
