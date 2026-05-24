import { requireAuth } from './authFirebase.js';
import { getPartnerByUserId } from '../services/publisherPartner.service.js';
import { partnerCanMonetize, partnerHasLimitedAccess } from '../utils/publisherUtils.js';
import { listWebsites } from '../services/publisherPartner.service.js';

export { requireAuth };

export async function requirePartnerAuth(req, res, next) {
  return requireAuth(req, res, async () => {
    try {
      const partner = await getPartnerByUserId(req.uid);
      if (!partner) {
        return res.status(403).json({ success: false, message: 'Partner account not found. Please register at /partner/signup.' });
      }
      req.partner = partner;
      return next();
    } catch (err) {
      return res.status(500).json({ success: false, message: err?.message || 'Failed' });
    }
  });
}

export async function requirePartnerMonetization(req, res, next) {
  try {
    const websites = await listWebsites(req.partner.id);
    if (!partnerCanMonetize(req.partner, websites)) {
      return res.status(403).json({
        success: false,
        message: 'Full monetization requires a verified website and admin approval.',
        code: 'MONETIZATION_LOCKED',
      });
    }
    req.partnerWebsites = websites;
    return next();
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export function attachPartnerAccessFlags(req, res, next) {
  req.partnerLimited = partnerHasLimitedAccess(req.partner);
  return next();
}
