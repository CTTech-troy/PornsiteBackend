import { supabase } from '../config/supabase.js';
import {
  generatePartnerCode,
  generatePublicToken,
  generateVerificationToken,
  normalizeDomain,
  partnerCanMonetize,
} from '../utils/publisherUtils.js';
import { sendPartnerVerificationEmail } from './emailService.js';

function isMissingTable(err) {
  return err?.code === '42P01' || err?.code === 'PGRST205' || /does not exist/i.test(String(err?.message || ''));
}

export async function getPartnerByUserId(userId) {
  if (!supabase || !userId) return null;
  const { data, error } = await supabase
    .from('publisher_partners')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error && !isMissingTable(error)) throw error;
  return data || null;
}

export async function getPartnerByCode(code) {
  if (!supabase || !code) return null;
  const { data, error } = await supabase
    .from('publisher_partners')
    .select('*')
    .eq('partner_code', code)
    .maybeSingle();
  if (error && !isMissingTable(error)) throw error;
  return data || null;
}

export async function registerPartner({ userId, email, companyName, contactName, roleType = 'webmaster' }) {
  if (!supabase) throw new Error('Database unavailable');
  const existing = await getPartnerByUserId(userId);
  if (existing) return existing;

  let partnerCode = generatePartnerCode();
  for (let i = 0; i < 5; i += 1) {
    const clash = await getPartnerByCode(partnerCode);
    if (!clash) break;
    partnerCode = generatePartnerCode();
  }

  const row = {
    user_id: userId,
    partner_code: partnerCode,
    company_name: companyName || null,
    contact_email: email || null,
    contact_name: contactName || null,
    role_type: roleType,
    status: 'pending',
    approval_status: 'limited',
  };

  const { data, error } = await supabase.from('publisher_partners').insert([row]).select('*').single();
  if (error) throw error;

  await supabase.from('users').update({ role: 'publisher', updated_at: new Date().toISOString() }).eq('id', userId);

  return data;
}

export async function updatePartner(partnerId, patch) {
  const { data, error } = await supabase
    .from('publisher_partners')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', partnerId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function listWebsites(partnerId) {
  const { data, error } = await supabase
    .from('publisher_websites')
    .select('*')
    .eq('partner_id', partnerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function createWebsite(partnerId, payload) {
  const domain = normalizeDomain(payload.siteUrl || payload.domain);
  if (!domain) throw new Error('Valid domain is required');

  const row = {
    partner_id: partnerId,
    domain,
    site_url: payload.siteUrl || `https://${domain}`,
    category: payload.category || null,
    traffic_source: payload.trafficSource || null,
    description: payload.description || null,
    logo_url: payload.logoUrl || null,
    monthly_traffic_estimate: payload.monthlyTrafficEstimate ? Number(payload.monthlyTrafficEstimate) : null,
    status: 'pending_review',
    verification_status: 'unverified',
  };

  const { data: website, error } = await supabase.from('publisher_websites').insert([row]).select('*').single();
  if (error) throw error;

  const token = generateVerificationToken();
  await supabase.from('publisher_website_verifications').insert([{
    website_id: website.id,
    method: payload.verificationMethod || 'meta',
    token,
    scan_status: 'idle',
  }]);

  try {
    const { data: partner } = await supabase
      .from('publisher_partners')
      .select('company_name, contact_email')
      .eq('id', partnerId)
      .maybeSingle();
    if (partner?.contact_email) {
      await sendPartnerVerificationEmail({
        to: partner.contact_email,
        companyName: partner.company_name || 'Publisher Partner',
        websiteUrl: website.site_url,
        verificationCode: `<meta name="xstream-verification" content="${token}">`,
        dashboardUrl: `${String(process.env.FRONTEND_URL || 'https://xstreamvideos.site').replace(/\/$/, '')}/partners/websites`,
      });
    }
  } catch (err) {
    console.warn('[publisher] verification email failed:', err?.message || err);
  }

  return website;
}

export async function getWebsiteVerification(websiteId) {
  const { data, error } = await supabase
    .from('publisher_website_verifications')
    .select('*')
    .eq('website_id', websiteId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function listAdUnits(partnerId) {
  const { data, error } = await supabase
    .from('publisher_ad_units')
    .select('*, publisher_embed_tokens(public_token, revoked_at, expires_at)')
    .eq('partner_id', partnerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function createAdUnit(partnerId, payload, { allowActive = false } = {}) {
  const partner = await supabase.from('publisher_partners').select('*').eq('id', partnerId).maybeSingle();
  const websites = await listWebsites(partnerId);
  const canActivate = allowActive && partnerCanMonetize(partner.data, websites);

  const row = {
    partner_id: partnerId,
    website_id: payload.websiteId || null,
    name: payload.name || 'Banner',
    unit_type: payload.unitType || 'banner',
    size: payload.size || '300x250',
    placement_hint: payload.placementHint || null,
    status: canActivate ? 'active' : 'draft',
  };

  const { data: unit, error } = await supabase.from('publisher_ad_units').insert([row]).select('*').single();
  if (error) throw error;

  const publicToken = generatePublicToken();
  await supabase.from('publisher_embed_tokens').insert([{
    ad_unit_id: unit.id,
    public_token: publicToken,
    allowed_domains: payload.allowedDomains || [],
  }]);

  return { ...unit, public_token: publicToken };
}

export async function getEmbedByToken(publicToken) {
  const { data, error } = await supabase
    .from('publisher_embed_tokens')
    .select('*, publisher_ad_units(*, publisher_partners(*), publisher_websites(*))')
    .eq('public_token', publicToken)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.revoked_at) return null;
  if (data.expires_at && new Date(data.expires_at) < new Date()) return null;
  return data;
}

export async function logAudit({ partnerId, websiteId, actorId, actorEmail, action, before, after }) {
  if (!supabase) return;
  await supabase.from('publisher_audit_log').insert([{
    partner_id: partnerId || null,
    website_id: websiteId || null,
    actor_id: actorId || null,
    actor_email: actorEmail || null,
    action,
    before_state: before || null,
    after_state: after || null,
  }]);
}

export async function createInquiry(payload) {
  const { data, error } = await supabase.from('publisher_partner_inquiries').insert([{
    name: payload.name,
    company: payload.company || null,
    email: payload.email,
    website_url: payload.websiteUrl || null,
    partnership_type: payload.partnershipType || null,
    country: payload.country || null,
    message: payload.message || null,
  }]).select('*').single();
  if (error) throw error;
  return data;
}

export async function listPartnersAdmin({ status } = {}) {
  let q = supabase.from('publisher_partners').select('*').order('created_at', { ascending: false });
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function approvePartner(partnerId, admin) {
  const updated = await updatePartner(partnerId, { status: 'active', approval_status: 'approved' });
  await logAudit({ partnerId, actorId: admin?.id, actorEmail: admin?.email, action: 'approve_partner', after: updated });
  return updated;
}
