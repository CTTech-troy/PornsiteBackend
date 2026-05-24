import { supabase, isConfigured } from '../config/supabase.js';

const COMPANY_ACCOUNT_ID = String(process.env.COMPANY_ACCOUNT_ID || 'xstream-official').trim();
const COMPANY_USERNAME = String(process.env.COMPANY_USERNAME || 'Xstream').trim();
const COMPANY_DISPLAY_NAME = String(process.env.COMPANY_DISPLAY_NAME || COMPANY_USERNAME || 'Xstream').trim();
const COMPANY_EMAIL = String(process.env.COMPANY_EMAIL || 'official@xstream.local').trim().toLowerCase();
const COMPANY_AVATAR_URL = String(process.env.COMPANY_AVATAR_URL || process.env.COMPANY_LOGO_URL || '/logo1.png').trim();
const COMPANY_BIO = String(
  process.env.COMPANY_BIO ||
  'Official Xstream platform uploads, curated imports, and company announcements.'
).trim();

let ensurePromise = null;
let ensuredAt = 0;
const ENSURE_TTL_MS = Math.max(10000, Number(process.env.COMPANY_ACCOUNT_ENSURE_TTL_MS || 300000));

function isMissingColumn(error) {
  const msg = String(error?.message || '');
  return error?.code === 'PGRST204' || error?.code === '42703' || /schema cache|Could not find|column/i.test(msg);
}

function missingColumnName(error) {
  const msg = String(error?.message || '');
  const quoted = msg.match(/'([^']+)'/);
  if (quoted?.[1]) return quoted[1];
  const named = msg.match(/column\s+["']?([a-zA-Z0-9_]+)["']?/i);
  return named?.[1] || null;
}

async function adaptiveUpsert(table, payload, onConflict) {
  if (!isConfigured() || !supabase) return null;
  let body = { ...payload };
  let lastError = null;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const { data, error } = await supabase
      .from(table)
      .upsert(body, { onConflict })
      .select('*')
      .maybeSingle();
    if (!error) return data || body;
    lastError = error;
    if (!isMissingColumn(error)) break;
    const missing = missingColumnName(error);
    if (!missing || !(missing in body)) break;
    delete body[missing];
  }
  if (lastError) throw lastError;
  return body;
}

export function getOfficialCompanyAccount() {
  return {
    id: COMPANY_ACCOUNT_ID,
    userId: COMPANY_ACCOUNT_ID,
    username: COMPANY_USERNAME,
    displayName: COMPANY_DISPLAY_NAME,
    name: COMPANY_DISPLAY_NAME,
    email: COMPANY_EMAIL,
    avatar: COMPANY_AVATAR_URL,
    avatarUrl: COMPANY_AVATAR_URL,
    bio: COMPANY_BIO,
    verified: true,
    creatorType: 'channel',
    protected: true,
  };
}

export function isOfficialCompanyIdentifier(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return false;
  return [
    COMPANY_ACCOUNT_ID.toLowerCase(),
    COMPANY_USERNAME.toLowerCase(),
    COMPANY_DISPLAY_NAME.toLowerCase(),
    'xstream',
    'xstreamvideos',
    'company',
    'official',
  ].includes(raw);
}

export async function ensureOfficialCompanyAccount({ force = false } = {}) {
  if (!isConfigured() || !supabase) return getOfficialCompanyAccount();
  const now = Date.now();
  if (!force && now - ensuredAt < ENSURE_TTL_MS) return getOfficialCompanyAccount();
  if (!force && ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    const profile = getOfficialCompanyAccount();
    const userPayload = {
      id: profile.id,
      username: profile.username,
      email: profile.email,
      display_name: profile.displayName,
      full_name: profile.displayName,
      avatar: profile.avatar,
      avatar_url: profile.avatarUrl,
      creator: true,
      verified: 'approved',
      creator_status: 'approved',
      role: 'company',
      email_verified: true,
      is_verified: true,
      banned: false,
      suspended: false,
      is_system_account: true,
      protected_account: true,
      official_company: true,
      updated_at: new Date().toISOString(),
    };
    const creatorPayload = {
      user_id: profile.id,
      display_name: profile.displayName,
      bio: profile.bio,
      creator_type: 'channel',
      active: true,
      status: 'active',
      is_system_account: true,
      protected_account: true,
      official_company: true,
      updated_at: new Date().toISOString(),
    };

    await adaptiveUpsert('users', userPayload, 'id').catch((err) => {
      console.warn('[officialCompany] user upsert skipped:', err?.message || err);
    });
    await adaptiveUpsert('creators', creatorPayload, 'user_id').catch((err) => {
      console.warn('[officialCompany] creator upsert skipped:', err?.message || err);
    });
    ensuredAt = Date.now();
    return profile;
  })().finally(() => {
    ensurePromise = null;
  });

  return ensurePromise;
}

export async function applyOfficialCompanyOwnership(row = {}, { source = 'imported', originalCreatorId = null } = {}) {
  const company = await ensureOfficialCompanyAccount();
  const metadata = {
    ...(row.metadata && typeof row.metadata === 'object' ? row.metadata : {}),
    officialCompany: true,
    originalCreatorId: originalCreatorId || row.user_id || row.creator_id || row.creatorId || null,
  };
  return {
    ...row,
    user_id: company.id,
    creator_id: company.id,
    creator_display_name: company.displayName,
    creator_avatar_url: company.avatarUrl,
    content_source: source,
    monetization_owner_id: company.id,
    official_company_content: true,
    metadata,
  };
}
