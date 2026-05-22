import { supabase, isConfigured } from '../config/supabase.js';

const CACHE_TTL_MS = 30_000;
let cachedSettings = null;
let cacheLoadedAt = 0;

const CURRENCY_OPTIONS = ['USD', 'NGN'];
const LANGUAGE_OPTIONS = ['en', 'en-US'];
const TIMEZONE_OPTIONS = ['UTC', 'Africa/Lagos', 'America/Los_Angeles', 'America/New_York', 'Europe/London'];
const QUALITY_OPTIONS = ['auto', '480p', '720p', '1080p'];
const STORAGE_OPTIONS = ['supabase', 'firebase', 'cloudinary', 's3', 'mux', 'bunny'];

export const PLATFORM_SETTINGS_CATALOG = [
  // Brand and company
  { key: 'platform_name', label: 'Platform Name', section: 'Brand', type: 'text', defaultValue: 'XStreamVideos', public: true, required: true },
  { key: 'platform_logo_url', label: 'Platform Logo URL', section: 'Brand', type: 'url', defaultValue: '', public: true },
  { key: 'platform_url', label: 'Platform URL', section: 'Brand', type: 'url', defaultValue: 'https://xstreamvideos.site', public: true, required: true },
  { key: 'support_email', label: 'Support Email', section: 'Brand', type: 'email', defaultValue: 'support@xstreamvideos.site', public: true, required: true },
  { key: 'contact_email', label: 'Contact Email', section: 'Brand', type: 'email', defaultValue: 'support@xstreamvideos.site', public: true },
  { key: 'contact_phone', label: 'Contact Phone', section: 'Brand', type: 'text', defaultValue: '', public: true },
  { key: 'company_name', label: 'Company Name', section: 'Brand', type: 'text', defaultValue: 'XStreamVideos', public: true },
  { key: 'company_address', label: 'Company Address', section: 'Brand', type: 'textarea', defaultValue: '', public: true },

  // Legal
  { key: 'terms_url', label: 'Terms URL', section: 'Legal', type: 'url', defaultValue: '/terms', public: true },
  { key: 'privacy_policy_url', label: 'Privacy Policy URL', section: 'Legal', type: 'url', defaultValue: '/privacy-policy', public: true },
  { key: 'privacy_notice_url', label: 'Privacy Notice URL', section: 'Legal', type: 'url', defaultValue: '/privacy-notice', public: true },
  { key: 'community_guidelines_url', label: 'Community Guidelines URL', section: 'Legal', type: 'url', defaultValue: '/legal/community-guidelines', public: true },
  { key: 'content_removal_url', label: 'Content Removal Policy URL', section: 'Legal', type: 'url', defaultValue: '/content-removal', public: true },
  { key: 'creator_terms_url', label: 'Creator Terms URL', section: 'Legal', type: 'url', defaultValue: '/terms', public: true },

  // Localization
  { key: 'default_currency', label: 'Default Currency', section: 'Localization', type: 'select', defaultValue: 'USD', options: CURRENCY_OPTIONS, public: true },
  { key: 'payout_currency', label: 'Payout Currency', section: 'Localization', type: 'select', defaultValue: 'NGN', options: CURRENCY_OPTIONS },
  { key: 'timezone', label: 'Timezone', section: 'Localization', type: 'select', defaultValue: 'UTC', options: TIMEZONE_OPTIONS, public: true },
  { key: 'platform_language', label: 'Platform Language', section: 'Localization', type: 'select', defaultValue: 'en', options: LANGUAGE_OPTIONS, public: true },
  { key: 'ngn_to_usd_rate', label: 'NGN to USD Rate', section: 'Localization', type: 'number', defaultValue: '1600', min: 1 },

  // Moderation and safety
  { key: 'content_moderation_enabled', label: 'Content Moderation Enabled', section: 'Moderation', type: 'toggle', defaultValue: 'true' },
  { key: 'manual_review_required', label: 'Manual Review Required', section: 'Moderation', type: 'toggle', defaultValue: 'true' },
  { key: 'ai_moderation_enabled', label: 'AI Moderation Enabled', section: 'Moderation', type: 'toggle', defaultValue: 'false' },
  { key: 'nsfw_moderation_enabled', label: 'NSFW Moderation Enabled', section: 'Moderation', type: 'toggle', defaultValue: 'true' },
  { key: 'auto_hide_report_threshold', label: 'Auto-hide Report Threshold', section: 'Moderation', type: 'number', defaultValue: '5', min: 1, max: 100 },
  { key: 'abuse_reporting_enabled', label: 'Reporting and Abuse Enabled', section: 'Moderation', type: 'toggle', defaultValue: 'true', public: true },
  { key: 'report_response_sla_hours', label: 'Report Response SLA (hours)', section: 'Moderation', type: 'number', defaultValue: '48', min: 1, max: 720 },

  // Creator payouts and revenue
  { key: 'creator_payouts_enabled', label: 'Creator Payouts Enabled', section: 'Creator Payouts', type: 'toggle', defaultValue: 'true' },
  { key: 'creator_payout_automation_enabled', label: 'Paystack Payout Automation', section: 'Creator Payouts', type: 'toggle', defaultValue: 'true' },
  { key: 'min_payout_usd', label: 'Minimum Payout (USD)', section: 'Creator Payouts', type: 'number', defaultValue: '5', min: 1, public: true },
  { key: 'payout_processing_days', label: 'Payout Processing Days', section: 'Creator Payouts', type: 'number', defaultValue: '3', min: 0, max: 30 },
  { key: 'creator_revenue_share_percent', label: 'Creator Revenue Share (%)', section: 'Creator Payouts', type: 'number', defaultValue: '70', min: 0, max: 100 },
  { key: 'platform_fee_percent', label: 'Platform Fee (%)', section: 'Creator Payouts', type: 'number', defaultValue: '30', min: 0, max: 100 },
  { key: 'live_gift_creator_percent', label: 'Live Gift Creator Share (%)', section: 'Creator Payouts', type: 'number', defaultValue: '70', min: 0, max: 100 },
  { key: 'live_gift_platform_percent', label: 'Live Gift Platform Share (%)', section: 'Creator Payouts', type: 'number', defaultValue: '30', min: 0, max: 100 },

  // Monetization
  { key: 'subscription_fee_enabled', label: 'Subscriptions Enabled', section: 'Monetization', type: 'toggle', defaultValue: 'true', public: true },
  { key: 'subscription_trial_days', label: 'Subscription Trial Days', section: 'Monetization', type: 'number', defaultValue: '0', min: 0, max: 365 },
  { key: 'ad_revenue_enabled', label: 'Ad Revenue Enabled', section: 'Monetization', type: 'toggle', defaultValue: 'true' },
  { key: 'ad_revenue_share_percent', label: 'Ad Revenue Creator Share (%)', section: 'Monetization', type: 'number', defaultValue: '50', min: 0, max: 100 },
  { key: 'coin_to_usd_rate', label: 'Coin to USD Rate', section: 'Monetization', type: 'number', defaultValue: '0.01', min: 0 },
  { key: 'premium_preview_seconds', label: 'Premium Preview Seconds', section: 'Monetization', type: 'number', defaultValue: '12', min: 0, max: 600, public: true },

  // Payment gateways
  { key: 'payment_gateway_primary', label: 'Primary Payment Gateway', section: 'Payments', type: 'select', defaultValue: 'paystack', options: ['paystack', 'flutterwave', 'manual'], public: true },
  { key: 'paystack_enabled', label: 'Paystack Enabled', section: 'Payments', type: 'toggle', defaultValue: 'true', public: true },
  { key: 'paystack_public_key', label: 'Paystack Public Key', section: 'Payments', type: 'text', defaultValue: '', public: true },
  { key: 'paystack_secret_key', label: 'Paystack Secret Key', section: 'Payments', type: 'secret', defaultValue: '', envKey: 'PAYSTACK_SECRET_KEY', sensitive: true },
  { key: 'paystack_webhook_url', label: 'Paystack Webhook URL', section: 'Payments', type: 'url', defaultValue: '/api/payments/webhooks/paystack' },
  { key: 'flutterwave_enabled', label: 'Flutterwave Enabled', section: 'Payments', type: 'toggle', defaultValue: 'true' },
  { key: 'flutterwave_public_key', label: 'Flutterwave Public Key', section: 'Payments', type: 'text', defaultValue: '', envKey: 'FLUTTERWAVE_PUBLIC_KEY', public: true },
  { key: 'flutterwave_secret_key', label: 'Flutterwave Secret Key', section: 'Payments', type: 'secret', defaultValue: '', envKey: 'FLUTTERWAVE_SECRET_KEY', sensitive: true },
  { key: 'flutterwave_webhook_url', label: 'Flutterwave Webhook URL', section: 'Payments', type: 'url', defaultValue: '/api/payments/webhooks/flutterwave' },

  // Notifications
  { key: 'email_notifications_enabled', label: 'Email Notifications Enabled', section: 'Notifications', type: 'toggle', defaultValue: 'true' },
  { key: 'support_notifications_email', label: 'Support Notifications Email', section: 'Notifications', type: 'email', defaultValue: 'support@xstreamvideos.site' },
  { key: 'resend_from_email', label: 'Transactional From Email', section: 'Notifications', type: 'email', defaultValue: 'XStreamVideos <support@xstreamvideos.site>' },
  { key: 'resend_api_key', label: 'Resend API Key', section: 'Notifications', type: 'secret', defaultValue: '', envKey: 'RESEND_API_KEY', sensitive: true },
  { key: 'push_notifications_enabled', label: 'Push Notifications Enabled', section: 'Notifications', type: 'toggle', defaultValue: 'false', public: true },
  { key: 'push_vapid_public_key', label: 'Push VAPID Public Key', section: 'Notifications', type: 'text', defaultValue: '', public: true },
  { key: 'push_vapid_private_key', label: 'Push VAPID Private Key', section: 'Notifications', type: 'secret', defaultValue: '', envKey: 'PUSH_VAPID_PRIVATE_KEY', sensitive: true },

  // Roles and access
  { key: 'default_user_role', label: 'Default User Role', section: 'Access', type: 'select', defaultValue: 'user', options: ['user', 'creator', 'admin'] },
  { key: 'creator_default_role', label: 'Approved Creator Role', section: 'Access', type: 'select', defaultValue: 'creator', options: ['creator'] },
  { key: 'admin_default_permissions', label: 'Default Admin Permissions JSON', section: 'Access', type: 'json', defaultValue: '["/"]' },
  { key: 'super_admin_required_for_payouts', label: 'Super Admin Required for Payouts', section: 'Access', type: 'toggle', defaultValue: 'false' },

  // Uploads and video
  { key: 'uploads_enabled', label: 'Uploads Enabled', section: 'Uploads', type: 'toggle', defaultValue: 'true', public: true },
  { key: 'max_video_size_mb', label: 'Max Video Size (MB)', section: 'Uploads', type: 'number', defaultValue: '1024', min: 1, max: 10240 },
  { key: 'max_thumbnail_size_mb', label: 'Max Thumbnail Size (MB)', section: 'Uploads', type: 'number', defaultValue: '10', min: 1, max: 100 },
  { key: 'allowed_video_types', label: 'Allowed Video Types JSON', section: 'Uploads', type: 'json', defaultValue: '["video/mp4","video/webm","application/x-mpegURL"]' },
  { key: 'video_storage_provider', label: 'Video Storage Provider', section: 'Uploads', type: 'select', defaultValue: 'supabase', options: STORAGE_OPTIONS },
  { key: 'default_video_quality', label: 'Default Video Quality', section: 'Uploads', type: 'select', defaultValue: 'auto', options: QUALITY_OPTIONS, public: true },
  { key: 'max_video_quality', label: 'Max Video Quality', section: 'Uploads', type: 'select', defaultValue: '1080p', options: QUALITY_OPTIONS },
  { key: 'hls_transcoding_enabled', label: 'HLS Transcoding Enabled', section: 'Uploads', type: 'toggle', defaultValue: 'false' },

  // Verification and creator onboarding
  { key: 'registration_open', label: 'Registration Open', section: 'Verification', type: 'toggle', defaultValue: 'true', public: true },
  { key: 'email_verification_required', label: 'Email Verification Required', section: 'Verification', type: 'toggle', defaultValue: 'true', public: true },
  { key: 'age_verification_required', label: 'Age Verification Required', section: 'Verification', type: 'toggle', defaultValue: 'true', public: true },
  { key: 'minimum_creator_age', label: 'Minimum Creator Age', section: 'Verification', type: 'number', defaultValue: '18', min: 18, max: 100, public: true },
  { key: 'creator_applications_open', label: 'Creator Applications Open', section: 'Verification', type: 'toggle', defaultValue: 'true', public: true },
  { key: 'creator_onboarding_requires_id', label: 'Creator Onboarding Requires ID', section: 'Verification', type: 'toggle', defaultValue: 'true' },
  { key: 'creator_onboarding_categories', label: 'Creator Types JSON', section: 'Verification', type: 'json', defaultValue: '["pstar","channel"]', public: true },

  // Analytics, security, API
  { key: 'analytics_enabled', label: 'Analytics Enabled', section: 'System', type: 'toggle', defaultValue: 'true' },
  { key: 'finance_hub_enabled', label: 'Finance Hub Enabled', section: 'System', type: 'toggle', defaultValue: 'true' },
  { key: 'maintenance_mode', label: 'Maintenance Mode', section: 'System', type: 'toggle', defaultValue: 'false', public: true },
  { key: 'api_base_url', label: 'Public API Base URL', section: 'System', type: 'url', defaultValue: '', public: true },
  { key: 'cors_allowed_origins', label: 'CORS Allowed Origins JSON', section: 'System', type: 'json', defaultValue: '[]' },
  { key: 'session_ttl_hours', label: 'Session TTL Hours', section: 'System', type: 'number', defaultValue: '168', min: 1, max: 8760 },
  { key: 'jwt_secret', label: 'User JWT Secret', section: 'System', type: 'secret', defaultValue: '', envKey: 'JWT_SECRET', sensitive: true },
  { key: 'admin_jwt_secret', label: 'Admin JWT Secret', section: 'System', type: 'secret', defaultValue: '', envKey: 'ADMIN_JWT_SECRET', sensitive: true },
  { key: 'supabase_service_role_key', label: 'Supabase Service Role Key', section: 'System', type: 'secret', defaultValue: '', envKey: 'SUPABASE_SERVICE_ROLE_KEY', sensitive: true },
  { key: 'firebase_service_account_key', label: 'Firebase Service Account Key', section: 'System', type: 'secret', defaultValue: '', envKey: 'FIREBASE_SERVICE_ACCOUNT_KEY', sensitive: true },
];

const CATALOG_BY_KEY = new Map(PLATFORM_SETTINGS_CATALOG.map((item) => [item.key, item]));

function isMissingSettingsTable(err) {
  return (
    err?.code === '42P01' ||
    err?.code === 'PGRST200' ||
    (typeof err?.message === 'string' && err.message.includes('schema cache'))
  );
}

function normalizeBoolean(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return ['true', '1', 'yes', 'on', 'enabled'].includes(v) ? 'true' : 'false';
}

function normalizeUrl(value) {
  const v = String(value ?? '').trim();
  if (!v) return '';
  if (v.startsWith('/')) return v;
  try {
    const u = new URL(v);
    return u.toString();
  } catch {
    throw new Error('Enter a valid URL or an absolute path beginning with /.');
  }
}

function normalizeEmail(value, required) {
  const v = String(value ?? '').trim();
  if (!v && !required) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && !/^[^<>]+<[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+>$/.test(v)) {
    throw new Error('Enter a valid email address.');
  }
  return v;
}

function normalizeJson(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    return JSON.stringify(JSON.parse(raw));
  } catch {
    throw new Error('Enter valid JSON.');
  }
}

export function sanitizeSettingValue(def, value) {
  if (def.sensitive) return { skip: true, value: '' };
  const raw = value ?? def.defaultValue ?? '';

  if (def.required && !String(raw).trim()) {
    throw new Error(`${def.label} is required.`);
  }

  if (def.type === 'toggle') return { value: normalizeBoolean(raw) };
  if (def.type === 'url') return { value: normalizeUrl(raw) };
  if (def.type === 'email') return { value: normalizeEmail(raw, def.required) };
  if (def.type === 'json') return { value: normalizeJson(raw) };
  if (def.type === 'select') {
    const v = String(raw || def.defaultValue || '').trim();
    if (def.options?.length && !def.options.includes(v)) {
      throw new Error(`${def.label} must be one of: ${def.options.join(', ')}.`);
    }
    return { value: v };
  }
  if (def.type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${def.label} must be a number.`);
    if (def.min != null && n < def.min) throw new Error(`${def.label} must be at least ${def.min}.`);
    if (def.max != null && n > def.max) throw new Error(`${def.label} must be at most ${def.max}.`);
    return { value: String(n) };
  }
  return { value: String(raw ?? '').trim() };
}

async function readStoredSettings() {
  if (!isConfigured() || !supabase) return { rows: [], tableMissing: true };
  const { data, error } = await supabase
    .from('platform_settings')
    .select('key, value, updated_at, updated_by, section, description, value_type, is_sensitive');
  if (error) {
    if (isMissingSettingsTable(error) || error.code === '42703' || error.code === 'PGRST204') {
      const fallback = await supabase.from('platform_settings').select('key, value, updated_at');
      if (fallback.error) {
        if (isMissingSettingsTable(fallback.error)) return { rows: [], tableMissing: true };
        throw fallback.error;
      }
      return { rows: fallback.data || [], tableMissing: false };
    }
    throw error;
  }
  return { rows: data || [], tableMissing: false };
}

export async function getPlatformSettingsMap(force = false) {
  if (!force && cachedSettings && Date.now() - cacheLoadedAt < CACHE_TTL_MS) return cachedSettings;

  const defaults = Object.fromEntries(
    PLATFORM_SETTINGS_CATALOG
      .filter((def) => !def.sensitive)
      .map((def) => [def.key, String(def.defaultValue ?? '')]),
  );

  try {
    const { rows } = await readStoredSettings();
    for (const row of rows) {
      if (row?.key && CATALOG_BY_KEY.has(row.key) && !CATALOG_BY_KEY.get(row.key).sensitive) {
        defaults[row.key] = String(row.value ?? '');
      }
    }
  } catch (_) {
    /* use defaults */
  }

  cachedSettings = defaults;
  cacheLoadedAt = Date.now();
  return cachedSettings;
}

export function invalidatePlatformSettingsCache() {
  cachedSettings = null;
  cacheLoadedAt = 0;
}

export async function getAdminSettingsPayload() {
  const { rows, tableMissing } = await readStoredSettings().catch((err) => {
    if (isMissingSettingsTable(err)) return { rows: [], tableMissing: true };
    throw err;
  });
  const stored = new Map((rows || []).map((row) => [row.key, row]));

  return {
    tableMissing,
    settings: PLATFORM_SETTINGS_CATALOG.map((def) => {
      const row = stored.get(def.key);
      const envConfigured = def.envKey ? Boolean(process.env[def.envKey]) : undefined;
      return {
        key: def.key,
        label: def.label,
        section: def.section,
        type: def.type,
        value: def.sensitive ? '' : String(row?.value ?? def.defaultValue ?? ''),
        defaultValue: String(def.defaultValue ?? ''),
        description: def.description || '',
        options: def.options || [],
        required: def.required === true,
        sensitive: def.sensitive === true,
        envKey: def.envKey || null,
        envConfigured,
        public: def.public === true,
        updated_at: row?.updated_at || null,
      };
    }),
  };
}

export async function saveAdminSettings(settings, adminName = 'Admin') {
  if (!Array.isArray(settings) || settings.length === 0) {
    const err = new Error('settings array required.');
    err.status = 400;
    throw err;
  }

  const errors = [];
  const rows = [];
  for (const input of settings) {
    const key = String(input?.key || '').trim();
    const def = CATALOG_BY_KEY.get(key);
    if (!def) {
      errors.push({ key, message: 'Unknown setting key.' });
      continue;
    }
    try {
      const sanitized = sanitizeSettingValue(def, input.value);
      if (sanitized.skip) continue;
      rows.push({
        key,
        value: sanitized.value,
        section: def.section,
        description: def.label,
        value_type: def.type,
        is_sensitive: false,
        updated_at: new Date().toISOString(),
        updated_by: adminName || 'Admin',
      });
    } catch (err) {
      errors.push({ key, message: err.message });
    }
  }

  if (errors.length) {
    const err = new Error('Some settings are invalid.');
    err.status = 400;
    err.errors = errors;
    throw err;
  }

  if (!rows.length) return { updatedKeys: [] };

  let { error } = await supabase.from('platform_settings').upsert(rows, { onConflict: 'key' });
  if (error && (error.code === '42703' || error.code === 'PGRST204')) {
    const fallbackRows = rows.map(({ key, value, updated_at }) => ({ key, value, updated_at }));
    const fallback = await supabase.from('platform_settings').upsert(fallbackRows, { onConflict: 'key' });
    error = fallback.error;
  }
  if (error) throw error;

  invalidatePlatformSettingsCache();
  return { updatedKeys: rows.map((row) => row.key) };
}

export async function getPublicPlatformSettings() {
  const map = await getPlatformSettingsMap();
  return Object.fromEntries(
    PLATFORM_SETTINGS_CATALOG
      .filter((def) => def.public && !def.sensitive)
      .map((def) => [def.key, map[def.key] ?? String(def.defaultValue ?? '')]),
  );
}

export async function getStringSetting(key, fallback = '') {
  const map = await getPlatformSettingsMap();
  return String(map[key] ?? fallback);
}

export async function getNumberSetting(key, fallback = 0) {
  const map = await getPlatformSettingsMap();
  const value = Array.isArray(key)
    ? key.map((k) => map[k]).find((v) => v != null && v !== '')
    : map[key];
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export async function getBooleanSetting(key, fallback = false) {
  const map = await getPlatformSettingsMap();
  if (map[key] == null) return fallback;
  return normalizeBoolean(map[key]) === 'true';
}
