import {
  registerPartner,
  getPartnerByUserId,
  updatePartner,
  createInquiry,
} from '../services/publisherPartner.service.js';
import { getPartnerOverview } from '../services/publisherAnalytics.service.js';
import { buildMetaTag } from '../services/publisherVerification.service.js';
import { listWebsites, getWebsiteVerification } from '../services/publisherPartner.service.js';
import { partnerCanMonetize } from '../utils/publisherUtils.js';

export async function postRegister(req, res) {
  try {
    const uid = req.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });

    const existing = await getPartnerByUserId(uid);
    if (existing) {
      return res.json({ success: true, partner: existing, existing: true });
    }

    const { companyName, contactName, roleType } = req.body || {};
    const email = req.body?.email || req.user?.email;
    const partner = await registerPartner({
      userId: uid,
      email,
      companyName,
      contactName,
      roleType: roleType || 'webmaster',
    });
    return res.status(201).json({ success: true, partner });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Registration failed' });
  }
}

export async function getMe(req, res) {
  try {
    const websites = await listWebsites(req.partner.id);
    const overview = await getPartnerOverview(req.partner.id);
    const verification = websites[0] ? await getWebsiteVerification(websites[0].id) : null;
    return res.json({
      success: true,
      partner: req.partner,
      websites,
      overview,
      canMonetize: partnerCanMonetize(req.partner, websites),
      metaTag: verification ? buildMetaTag(verification.token) : null,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function patchMe(req, res) {
  try {
    const patch = {};
    if (req.body?.companyName != null) patch.company_name = String(req.body.companyName).slice(0, 120);
    if (req.body?.contactName != null) patch.contact_name = String(req.body.contactName).slice(0, 80);
    if (req.body?.contactEmail != null) patch.contact_email = String(req.body.contactEmail).slice(0, 120);
    const partner = await updatePartner(req.partner.id, patch);
    return res.json({ success: true, partner });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function postInquiry(req, res) {
  try {
    const { name, company, email, websiteUrl, partnershipType, country, message } = req.body || {};
    if (!name || !email) return res.status(400).json({ success: false, message: 'Name and email are required' });
    const row = await createInquiry({ name, company, email, websiteUrl, partnershipType, country, message });
    return res.status(201).json({ success: true, inquiry: row });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}
