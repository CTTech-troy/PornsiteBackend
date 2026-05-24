import { supabase } from '../config/supabase.js';
import { getNetworkPricing } from '../services/adCampaign.service.js';
import { invalidatePlatformSettingsCache } from '../services/platformSettings.service.js';

async function upsertSetting(key, value) {
  await supabase.from('platform_settings').upsert({
    key,
    value: String(value),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'key' });
}

export async function getNetworkSettings(req, res) {
  try {
    const pricing = await getNetworkPricing();
    return res.json({ success: true, settings: pricing });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function saveNetworkSettings(req, res) {
  try {
    const {
      runAdFeeUsd,
      publishFeeUsd,
      sidebarMinActiveAds,
      rotationSeconds,
    } = req.body || {};

    if (runAdFeeUsd != null) await upsertSetting('network_partner_run_ad_fee_usd', runAdFeeUsd);
    if (publishFeeUsd != null) await upsertSetting('network_partner_publish_fee_usd', publishFeeUsd);
    if (sidebarMinActiveAds != null) await upsertSetting('sidebar_min_active_ads', sidebarMinActiveAds);
    if (rotationSeconds != null) await upsertSetting('network_rotation_seconds', rotationSeconds);
    invalidatePlatformSettingsCache();

    const settings = await getNetworkPricing();
    return res.json({ success: true, settings });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function listNetworkOrders(req, res) {
  try {
    const { data, error } = await supabase
      .from('ad_network_orders')
      .select('*, ad_campaigns(name, image_url, status), publisher_partners(company_name, partner_code, contact_email)')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    return res.json({ success: true, data: data || [] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}

export async function markOrderPaid(req, res) {
  try {
    const { id } = req.params;
    const { data: order, error } = await supabase
      .from('ad_network_orders')
      .update({
        status: 'paid',
        paid_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*, ad_campaigns(*)')
      .single();

    if (error) throw error;
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    if (order.campaign_id) {
      await supabase.from('ad_campaigns').update({
        payment_status: 'paid',
        paid_at: new Date().toISOString(),
        status: 'active',
        is_active: true,
        updated_at: new Date().toISOString(),
      }).eq('id', order.campaign_id);
    }

    return res.json({ success: true, order });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}
