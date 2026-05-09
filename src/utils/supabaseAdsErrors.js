const ADS_MIGRATION_HINT =
  'Ad campaigns schema issue: apply backend/supabase/migrations/20260503231000_011_ads_upgrade_full.sql (or 20260503000000_ad_campaigns_create.sql), then run backend/supabase/migrations/20260505220000_postgrest_reload_ad_campaigns.sql or call notify_pgrst_reload_schema() as service_role.';

export function isAdsSchemaMissing(error) {
  if (!error) return false;
  const code = String(error.code || '').toUpperCase();
  if (code === '42P01' || code === 'PGRST205') return true;
  const msg = String(error.message || error.details || error.hint || '').toLowerCase();
  if (msg.includes('relation') && msg.includes('does not exist')) return true;
  if (msg.includes('column') && msg.includes('does not exist')) return true;
  if (msg.includes('schema cache') && (msg.includes('ad_campaign') || msg.includes('ad_impression') || msg.includes('ad_click'))) return true;
  if (msg.includes('could not find the table') && msg.includes('ad_campaign')) return true;
  if (msg.includes('could not find the table') && msg.includes('schema cache') && msg.includes('ad_campaign')) return true;
  return false;
}

export async function tryNotifyPgrstReloadSchema(supabaseClient) {
  if (!supabaseClient) return false;
  try {
    const { error } = await supabaseClient.rpc('notify_pgrst_reload_schema');
    return !error;
  } catch {
    return false;
  }
}

export function adsSchemaMissingPayload() {
  return {
    code: 'ADS_SCHEMA_MISSING',
    message: ADS_MIGRATION_HINT,
    adsSchemaReady: false,
  };
}
