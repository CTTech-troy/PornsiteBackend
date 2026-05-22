import { supabase } from '../config/supabase.js';

const REVENUE_SETTING_KEYS = new Set([
  'platform_fee_percent',
  'creator_revenue_share_percent',
  'tax_percent',
  'withdrawal_fee_percent',
  'subscription_platform_fee_percent',
  'subscription_fee_percent',
  'processing_fee_percent',
  'min_payout_usd',
  'default_currency',
  'payout_currency',
  'live_gift_creator_percent',
  'live_gift_platform_percent',
  'revenue_commission_rules',
  'video_purchase_creator_percent',
  'video_purchase_platform_percent',
  'ngn_to_usd_rate',
  'coin_to_usd_rate',
]);

function isMissingTable(error) {
  return error?.code === '42P01' || error?.code === 'PGRST200';
}

export function isRevenueSettingKey(key) {
  return REVENUE_SETTING_KEYS.has(key);
}

export async function logPlatformSettingChanges(changes, admin = {}) {
  if (!supabase || !changes?.length) return { logged: 0 };
  const rows = changes
    .filter((c) => c.key && c.oldValue !== c.newValue)
    .map((c) => ({
      setting_key: c.key,
      old_value: c.oldValue == null ? null : String(c.oldValue),
      new_value: c.newValue == null ? null : String(c.newValue),
      changed_by: admin.name || admin.email || 'Admin',
      admin_id: admin.id || null,
      created_at: new Date().toISOString(),
    }));

  if (!rows.length) return { logged: 0 };

  const { error } = await supabase.from('platform_settings_audit').insert(rows);
  if (error && isMissingTable(error)) return { logged: 0, tableMissing: true };
  if (error) throw error;
  return { logged: rows.length };
}

export async function getRevenueSettingsAuditHistory(limit = 50) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('platform_settings_audit')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(Math.min(200, Math.max(1, limit)));

  if (error && isMissingTable(error)) return [];
  if (error) throw error;
  return data || [];
}
