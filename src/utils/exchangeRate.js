import { supabase, isConfigured as isSupabaseConfigured } from '../config/supabase.js';

const ENV_RATE = parseFloat(process.env.NGN_TO_USD_RATE) || 1600;

let cachedRate = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function getNgnToUsdRate() {
  if (cachedRate && Date.now() < cacheExpiry) return cachedRate;

  if (isSupabaseConfigured() && supabase) {
    try {
      const { data } = await supabase
        .from('platform_settings')
        .select('value')
        .eq('key', 'ngn_to_usd_rate')
        .maybeSingle();
      if (data?.value) {
        const r = parseFloat(data.value);
        if (r > 0) {
          cachedRate = r;
          cacheExpiry = Date.now() + CACHE_TTL_MS;
          return r;
        }
      }
    } catch (_) {}
  }

  cachedRate = ENV_RATE;
  cacheExpiry = Date.now() + CACHE_TTL_MS;
  return ENV_RATE;
}

export function ngnToUsd(amountNgn, rate) {
  return amountNgn / rate;
}
