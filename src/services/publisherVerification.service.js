import dns from 'dns/promises';
import { supabase } from '../config/supabase.js';
import { normalizeDomain } from '../utils/publisherUtils.js';

const META_NAME = 'xstream-verification';
const FETCH_TIMEOUT_MS = 15000;

async function fetchHtml(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'XstreamPublisherVerifier/1.0' },
      redirect: 'follow',
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text: text.slice(0, 500000) };
  } finally {
    clearTimeout(timer);
  }
}

function parseMetaToken(html, expectedToken) {
  const re = new RegExp(`<meta[^>]+name=["']${META_NAME}["'][^>]+content=["']([^"']+)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${META_NAME}["']`, 'i');
  const m = html.match(re) || html.match(re2);
  if (!m) return false;
  return String(m[1]).trim() === expectedToken;
}

export async function scanWebsiteVerification(websiteId) {
  if (!supabase) throw new Error('Database unavailable');

  const { data: website, error: wErr } = await supabase
    .from('publisher_websites')
    .select('*, publisher_website_verifications(*)')
    .eq('id', websiteId)
    .maybeSingle();
  if (wErr) throw wErr;
  if (!website) throw new Error('Website not found');

  const verification = (website.publisher_website_verifications || [])[0]
    || (await supabase.from('publisher_website_verifications').select('*').eq('website_id', websiteId).limit(1).maybeSingle()).data;
  if (!verification) throw new Error('Verification record not found');

  const domain = normalizeDomain(website.domain || website.site_url);
  const token = verification.token;
  const method = verification.method || 'meta';
  const log = [];
  let passed = false;
  let failureReason = null;

  await supabase.from('publisher_website_verifications').update({
    scan_status: 'scanning',
    last_scan_at: new Date().toISOString(),
  }).eq('id', verification.id);

  try {
    if (method === 'meta' || method === 'html_file') {
      const urls = [`https://${domain}`, `https://www.${domain}`, `http://${domain}`];
      for (const url of urls) {
        log.push({ step: 'fetch', url });
        const { ok, text } = await fetchHtml(url);
        if (!ok) continue;
        if (method === 'meta' && parseMetaToken(text, token)) {
          passed = true;
          log.push({ step: 'meta_found', url });
          break;
        }
        if (method === 'html_file' && text.includes(token)) {
          passed = true;
          log.push({ step: 'html_file_found', url });
          break;
        }
      }
      if (!passed) failureReason = method === 'meta' ? 'Meta verification tag not found' : 'Verification file content not found';
    }

    if (method === 'dns_txt' && !passed) {
      const host = domain;
      const records = await dns.resolveTxt(host).catch(() => []);
      const flat = records.flat().join('');
      log.push({ step: 'dns_txt', records: records.length });
      if (flat.includes(`xstream-verification=${token}`) || flat.includes(token)) {
        passed = true;
      } else {
        failureReason = 'DNS TXT record not found';
      }
    }
  } catch (err) {
    failureReason = err?.message || 'Verification scan failed';
    log.push({ step: 'error', message: failureReason });
  }

  const scanStatus = passed ? 'passed' : 'failed';
  await supabase.from('publisher_website_verifications').update({
    scan_status: scanStatus,
    verified_at: passed ? new Date().toISOString() : null,
    failure_reason: failureReason,
    scan_log: log,
    updated_at: new Date().toISOString(),
  }).eq('id', verification.id);

  await supabase.from('publisher_websites').update({
    verification_status: passed ? 'verified' : 'failed',
    status: passed ? 'pending_review' : website.status,
    updated_at: new Date().toISOString(),
  }).eq('id', websiteId);

  return { passed, failureReason, log };
}

export function buildMetaTag(token) {
  return `<meta name="${META_NAME}" content="${token}">`;
}

export function buildDnsInstruction(domain, token) {
  return `xstream-verification=${token}`;
}

export function buildHtmlFileContent(token) {
  return `xstream-verification:${token}`;
}
