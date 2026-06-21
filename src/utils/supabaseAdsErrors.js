const ADS_MIGRATION_HINT =
  'Ad campaigns schema issue: apply backend/supabase/migrations/20260708130000_ad_campaigns_schema_repair.sql in Supabase, then reload the PostgREST schema cache.';

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

export function isAdsTableMissing(error) {
  if (!error) return false;
  const code = String(error.code || '').toUpperCase();
  if (code === '42P01' || code === 'PGRST205') return true;
  const msg = String(error.message || error.details || error.hint || '').toLowerCase();
  if (msg.includes('relation') && msg.includes('ad_campaign') && msg.includes('does not exist')) return true;
  if (msg.includes('could not find the table') && msg.includes('ad_campaign')) return true;
  return false;
}

export function missingAdsColumnName(error) {
  if (!error) return null;
  const text = String(error.message || error.details || error.hint || '');
  const patterns = [
    /column\s+ad_campaigns\.([a-z0-9_]+)\s+does not exist/i,
    /column\s+"?([a-z0-9_]+)"?\s+of\s+"?ad_campaigns"?\s+does not exist/i,
    /could not find the\s+'([^']+)'\s+column\s+of\s+'ad_campaigns'/i,
    /could not find the\s+"([^"]+)"\s+column\s+of\s+"ad_campaigns"/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
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
