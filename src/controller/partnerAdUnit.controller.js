import { supabase } from '../config/supabase.js';
import {
  listAdUnits,
  createAdUnit,
} from '../services/publisherPartner.service.js';
import { buildBannerHtml, buildJsEmbed } from '../services/publisherAdServe.service.js';
import { partnerCanMonetize } from '../utils/publisherUtils.js';
import { listWebsites } from '../services/publisherPartner.service.js';

const apiBase = () => process.env.PUBLIC_API_URL || process.env.API_BASE_URL || 'https://api.xstreamvideos.site';

export async function list(req, res) {
  try {
    const units = await listAdUnits(req.partner.id);
    return res.json({ success: true, data: units });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function create(req, res) {
  try {
    const websites = await listWebsites(req.partner.id);
    const canMonetize = partnerCanMonetize(req.partner, websites);
    const unit = await createAdUnit(req.partner.id, req.body || {}, { allowActive: canMonetize });
    return res.status(201).json({ success: true, unit });
  } catch (err) {
    return res.status(400).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function getEmbed(req, res) {
  try {
    const { id } = req.params;
    const { data: unit } = await supabase
      .from('publisher_ad_units')
      .select('*, publisher_embed_tokens(*)')
      .eq('id', id)
      .eq('partner_id', req.partner.id)
      .maybeSingle();
    if (!unit) return res.status(404).json({ success: false, message: 'Ad unit not found' });

    const token = unit.publisher_embed_tokens?.[0]?.public_token;
    if (!token) return res.status(404).json({ success: false, message: 'Embed token not found' });

    const base = apiBase();
    const clickUrl = `${base}/api/publisher/click/${token}`;
    const imgUrl = `${base}/api/publisher/serve/${token}/image`;
    const { w, h } = (() => {
      const [width, height] = String(unit.size || '300x250').split('x').map(Number);
      return { w: width || 300, h: height || 250 };
    })();

    const html = `<a href="${clickUrl}" target="_blank" rel="noopener sponsored"><img src="${imgUrl}" width="${w}" height="${h}" alt="Advertisement" border="0"></a>`;
    const js = buildJsEmbed(token, base);
    const iframe = `<iframe src="${base}/api/publisher/serve/${token}" width="${w}" height="${h}" frameborder="0" scrolling="no" style="border:0;overflow:hidden;"></iframe>`;

    return res.json({
      success: true,
      token,
      formats: { html, js, iframe, smartLink: clickUrl },
      previewUrl: `${base}/api/publisher/serve/${token}`,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function patch(req, res) {
  try {
    const { id } = req.params;
    const patch = { updated_at: new Date().toISOString() };
    if (req.body?.name) patch.name = req.body.name;
    if (req.body?.status) patch.status = req.body.status;
    const { data, error } = await supabase.from('publisher_ad_units').update(patch).eq('id', id).eq('partner_id', req.partner.id).select('*').single();
    if (error) throw error;
    return res.json({ success: true, unit: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}
