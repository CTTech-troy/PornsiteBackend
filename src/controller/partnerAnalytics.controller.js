import { getPartnerOverview, getPartnerEventSeries } from '../services/publisherAnalytics.service.js';
import { supabase } from '../config/supabase.js';

export async function overview(req, res) {
  try {
    const data = await getPartnerOverview(req.partner.id);
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function chart(req, res) {
  try {
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 14));
    const series = await getPartnerEventSeries(req.partner.id, days);
    return res.json({ success: true, series });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function referrals(req, res) {
  try {
    const { data, error } = await supabase
      .from('publisher_referrals')
      .select('*')
      .eq('partner_id', req.partner.id)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;

    const base = process.env.PUBLIC_SITE_URL || 'https://xstreamvideos.site';
    const code = req.partner.partner_code;
    const links = {
      user: `${base}/signup?ref=${code}`,
      creator: `${base}/creator?ref=${code}`,
      advertiser: `${base}/webmasters?publisher=${code}`,
    };
    return res.json({ success: true, links, referrals: data || [] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function earnings(req, res) {
  try {
    const { data, error } = await supabase
      .from('publisher_earnings')
      .select('*')
      .eq('partner_id', req.partner.id)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    return res.json({ success: true, data: data || [], partner: req.partner });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function requestPayout(req, res) {
  try {
    const amount = Number(req.body?.amountUsd);
    const min = 25;
    const available = Number(req.partner.pending_usd || 0);
    if (!amount || amount < min) return res.status(400).json({ success: false, message: `Minimum payout is $${min}` });
    if (amount > available) return res.status(400).json({ success: false, message: 'Insufficient balance' });

    const { data, error } = await supabase.from('publisher_payout_requests').insert([{
      partner_id: req.partner.id,
      amount_usd: amount,
      payout_method: req.body?.payoutMethod || 'bank',
      payout_details: req.body?.payoutDetails || {},
      status: 'pending',
    }]).select('*').single();
    if (error) throw error;

    await supabase.from('publisher_partners').update({
      pending_usd: available - amount,
      updated_at: new Date().toISOString(),
    }).eq('id', req.partner.id);

    return res.status(201).json({ success: true, payout: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function listPayouts(req, res) {
  try {
    const { data, error } = await supabase
      .from('publisher_payout_requests')
      .select('*')
      .eq('partner_id', req.partner.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return res.json({ success: true, data: data || [] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}
