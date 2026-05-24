import {
  listWebsites,
  createWebsite,
  getWebsiteVerification,
  logAudit,
} from '../services/publisherPartner.service.js';
import {
  scanWebsiteVerification,
  buildMetaTag,
  buildDnsInstruction,
  buildHtmlFileContent,
} from '../services/publisherVerification.service.js';
import { supabase } from '../config/supabase.js';

export async function list(req, res) {
  try {
    const websites = await listWebsites(req.partner.id);
    return res.json({ success: true, data: websites });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function create(req, res) {
  try {
    const website = await createWebsite(req.partner.id, req.body || {});
    const verification = await getWebsiteVerification(website.id);
    return res.status(201).json({
      success: true,
      website,
      verification: {
        ...verification,
        metaTag: buildMetaTag(verification.token),
        dnsTxt: buildDnsInstruction(website.domain, verification.token),
        htmlFile: buildHtmlFileContent(verification.token),
      },
    });
  } catch (err) {
    return res.status(400).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function getVerification(req, res) {
  try {
    const { id } = req.params;
    const { data: website } = await supabase.from('publisher_websites').select('*').eq('id', id).eq('partner_id', req.partner.id).maybeSingle();
    if (!website) return res.status(404).json({ success: false, message: 'Website not found' });
    const verification = await getWebsiteVerification(id);
    return res.json({
      success: true,
      website,
      verification: {
        ...verification,
        metaTag: buildMetaTag(verification.token),
        dnsTxt: buildDnsInstruction(website.domain, verification.token),
        htmlFile: buildHtmlFileContent(verification.token),
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function postVerify(req, res) {
  try {
    const { id } = req.params;
    const { data: website } = await supabase.from('publisher_websites').select('*').eq('id', id).eq('partner_id', req.partner.id).maybeSingle();
    if (!website) return res.status(404).json({ success: false, message: 'Website not found' });

    const result = await scanWebsiteVerification(id);
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Verification failed' });
  }
}

export async function adminApproveWebsite(req, res) {
  try {
    const { id } = req.params;
    const { data, error } = await supabase.from('publisher_websites').update({
      status: 'approved',
      updated_at: new Date().toISOString(),
    }).eq('id', id).select('*').single();
    if (error) throw error;
    await logAudit({ websiteId: id, actorId: req.admin?.id, actorEmail: req.admin?.email, action: 'approve_website', after: data });
    return res.json({ success: true, website: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}
