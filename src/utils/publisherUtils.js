import { createHash, randomBytes } from 'crypto';

export function normalizeDomain(input) {
  let raw = String(input || '').trim().toLowerCase();
  if (!raw) return '';
  try {
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
    const u = new URL(raw);
    let host = u.hostname.replace(/^www\./, '');
    return host;
  } catch {
    return raw.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }
}

export function generatePartnerCode(prefix = 'xs') {
  return `${prefix}_${randomBytes(4).toString('hex')}`;
}

export function generateVerificationToken() {
  return randomBytes(16).toString('hex');
}

export function generatePublicToken() {
  return randomBytes(24).toString('base64url');
}

export function hashIp(ip) {
  return createHash('sha256').update(String(ip || 'unknown')).digest('hex').slice(0, 32);
}

export function partnerCanMonetize(partner, websites = []) {
  if (!partner) return false;
  if (partner.status !== 'active' || partner.approval_status !== 'approved') return false;
  return websites.some((w) => w.status === 'approved' && w.verification_status === 'verified');
}

export function partnerHasLimitedAccess(partner) {
  if (!partner) return false;
  return partner.status === 'pending' || partner.approval_status === 'limited' || partner.approval_status === 'pending';
}
