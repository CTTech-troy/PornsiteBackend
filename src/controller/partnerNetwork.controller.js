import { supabase } from '../config/supabase.js';
import { listActiveCampaigns, getNetworkPricing, mapCampaignRow } from '../services/adCampaign.service.js';
import { buildJsEmbed } from '../services/publisherAdServe.service.js';

const apiBase = () => process.env.PUBLIC_API_URL || process.env.API_BASE_URL || 'https://api.xstreamvideos.site';

export async function getNetworkLibrary(req, res) {
  try {
    const rows = await listActiveCampaigns(null, { networkOnly: true });
    const base = apiBase();
    const creatives = rows.map((row) => {
      const ad = mapCampaignRow(row);
      return {
        ...ad,
        previewUrl: ad.imageUrl,
        embedSnippet: ad.imageUrl
          ? `<a href="${ad.clickUrl || base}" target="_blank" rel="sponsored"><img src="${ad.imageUrl}" width="300" height="250" alt="${ad.title}"></a>`
          : null,
      };
    });
    return res.json({ success: true, creatives });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function getNetworkPricingHandler(req, res) {
  try {
    const pricing = await getNetworkPricing();
    return res.json({ success: true, pricing });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function submitNetworkCampaign(req, res) {
  try {
    const partner = req.partner;
    const {
      name, description, redirect_url, image_url, image_width, image_height,
    } = req.body || {};

    if (!name?.trim()) return res.status(400).json({ success: false, message: 'Campaign name is required' });
    if (!image_url?.trim()) return res.status(400).json({ success: false, message: 'Image URL is required' });
    if (redirect_url && !/^https?:\/\/.+/i.test(redirect_url.trim())) {
      return res.status(400).json({ success: false, message: 'Redirect URL must be http(s)' });
    }

    const pricing = await getNetworkPricing();
    const fee = pricing.runAdFeeUsd;

    const { data: campaign, error: campErr } = await supabase
      .from('ad_campaigns')
      .insert({
        name: name.trim(),
        description: description?.trim() || null,
        redirect_url: redirect_url?.trim() || null,
        image_url: image_url.trim(),
        image_width: parseInt(image_width, 10) || null,
        image_height: parseInt(image_height, 10) || null,
        placement: 'sidebar',
        source_type: 'image',
        ownership: 'partner',
        partner_id: partner.id,
        network_visible: true,
        status: 'pending',
        is_active: false,
        payment_status: fee > 0 ? 'pending' : 'paid',
        publish_fee_usd: fee,
        priority: 50,
      })
      .select('*')
      .single();

    if (campErr) throw campErr;

    const { data: order, error: orderErr } = await supabase
      .from('ad_network_orders')
      .insert({
        campaign_id: campaign.id,
        partner_id: partner.id,
        order_type: 'run_on_network',
        amount_usd: fee,
        status: fee > 0 ? 'pending' : 'paid',
        paid_at: fee > 0 ? null : new Date().toISOString(),
      })
      .select('*')
      .single();

    if (orderErr) throw orderErr;

    return res.status(201).json({
      success: true,
      campaign,
      order,
      message: fee > 0
        ? `Campaign submitted. Pay $${fee} — admin will activate after payment is confirmed.`
        : 'Campaign submitted for admin review.',
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function listMyNetworkCampaigns(req, res) {
  try {
    const { data, error } = await supabase
      .from('ad_campaigns')
      .select('*, ad_network_orders(*)')
      .eq('partner_id', req.partner.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return res.json({ success: true, data: data || [] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export function getHouseAdEmbedSnippet(req, res) {
  const base = apiBase();
  const js = buildJsEmbed('NETWORK', base);
  return res.json({
    success: true,
    note: 'Partners use ad units from Ad Units — those serve your approved network creatives automatically.',
    sampleIframe: `<iframe src="${base}/api/publisher/serve/YOUR_TOKEN" width="300" height="250" frameborder="0"></iframe>`,
    sampleJs: js,
  });
}
