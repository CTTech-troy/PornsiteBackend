import { supabase } from '../config/supabase.js';
import {
  listPartnersAdmin,
  approvePartner,
  logAudit,
} from '../services/publisherPartner.service.js';
import { updatePartnerFraudScore } from '../services/publisherFraud.service.js';
import { scanWebsiteVerification } from '../services/publisherVerification.service.js';

export async function listPartners(req, res) {
  try {
    const partners = await listPartnersAdmin({ status: req.query.status });
    return res.json({ success: true, data: partners });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function approvePartnerHandler(req, res) {
  try {
    const partner = await approvePartner(req.params.id, req.admin);
    return res.json({ success: true, partner });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function suspendPartner(req, res) {
  try {
    const { data, error } = await supabase.from('publisher_partners').update({
      status: 'suspended',
      updated_at: new Date().toISOString(),
    }).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    await logAudit({ partnerId: req.params.id, actorId: req.admin?.id, action: 'suspend_partner', after: data });
    return res.json({ success: true, partner: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function listWebsites(req, res) {
  try {
    const { data, error } = await supabase
      .from('publisher_websites')
      .select('*, publisher_partners(company_name, partner_code, contact_email)')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return res.json({ success: true, data: data || [] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function rescanWebsite(req, res) {
  try {
    const result = await scanWebsiteVerification(req.params.id);
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function listPayouts(req, res) {
  try {
    const { data, error } = await supabase
      .from('publisher_payout_requests')
      .select('*, publisher_partners(company_name, partner_code, contact_email)')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return res.json({ success: true, data: data || [] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function updatePayoutStatus(req, res) {
  try {
    const { status } = req.body || {};
    const { data, error } = await supabase.from('publisher_payout_requests').update({
      status,
      paid_at: status === 'paid' ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    }).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    return res.json({ success: true, payout: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function fraudRescore(req, res) {
  try {
    const score = await updatePartnerFraudScore(req.params.id);
    return res.json({ success: true, fraudScore: score });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function overview(req, res) {
  try {
    const { count: partners } = await supabase.from('publisher_partners').select('id', { count: 'exact', head: true });
    const { count: websites } = await supabase.from('publisher_websites').select('id', { count: 'exact', head: true });
    const { count: pending } = await supabase.from('publisher_partners').select('id', { count: 'exact', head: true }).eq('status', 'pending');
    return res.json({
      success: true,
      stats: { partners: partners || 0, websites: websites || 0, pendingPartners: pending || 0 },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}
