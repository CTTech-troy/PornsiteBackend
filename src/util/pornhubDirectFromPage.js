const WATCH_PAGE =
  'https://www.pornhub.com/view_video.php?viewkey=';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function allowedStreamHost(hostname) {
  if (!hostname) return false;
  const h = String(hostname).toLowerCase();
  return (
    h.endsWith('.phncdn.com') ||
    h.endsWith('.phprcdn.com') ||
    h === 'pornhub.com' ||
    h.endsWith('.pornhub.com')
  );
}

function safeUrl(u) {
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (!allowedStreamHost(parsed.hostname)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function unescapeJsonFragment(s) {
  return String(s)
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function qualityScoreFromLabel(q) {
  if (q == null) return 0;
  const m = String(q).match(/(\d{3,4})/);
  return m ? parseInt(m[1], 10) : 0;
}

function collectFromMediaDefinitionsArray(arr) {
  if (!Array.isArray(arr)) return [];
  const rows = [];
  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') continue;
    const format = String(entry.format || '').toLowerCase();
    const u = entry.videoUrl || entry.video_url;
    if (typeof u !== 'string' || !/^https?:\/\//i.test(u)) continue;
    const href = safeUrl(unescapeJsonFragment(u));
    if (!href) continue;
    if (format === 'mp4' || /\.mp4(\?|$)/i.test(href)) {
      rows.push({
        url: href,
        q: qualityScoreFromLabel(entry.quality || entry.height || entry.label),
      });
    }
  }
  return rows;
}

function sliceBalancedArray(html, openBracketIndex) {
  let depth = 0;
  let inString = false;
  let esc = false;
  for (let i = openBracketIndex; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === '\\') {
        esc = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return html.slice(openBracketIndex, i + 1);
    }
  }
  return null;
}

function tryParseMediaDefinitionsBlock(html) {
  const needle = '"mediaDefinitions"';
  let pos = 0;
  const candidates = [];
  while ((pos = html.indexOf(needle, pos)) !== -1) {
    const colon = html.indexOf(':', pos + needle.length);
    if (colon === -1) break;
    const lb = html.indexOf('[', colon);
    if (lb === -1) break;
    const slice = sliceBalancedArray(html, lb);
    if (slice) {
      try {
        const parsed = JSON.parse(slice);
        candidates.push(...collectFromMediaDefinitionsArray(parsed));
      } catch {
        /* ignore */
      }
    }
    pos += needle.length;
  }
  return candidates;
}

function regexVideoUrls(html) {
  const re = /"videoUrl"\s*:\s*"((?:\\.|[^"\\])*)"/gi;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1];
    const u = unescapeJsonFragment(raw);
    const href = safeUrl(u);
    if (href && (/\.mp4(\?|#|$)/i.test(href) || href.includes('.mp4?'))) {
      out.push({ url: href, q: 0 });
    }
  }
  return out;
}

/**
 * Fetch Pornhub watch page HTML and try to resolve a direct MP4 URL for <video src>.
 * @param {string} viewkey
 * @returns {Promise<string|null>}
 */
export async function fetchPornhubDirectMp4FromWatchPage(viewkey) {
  if (!viewkey || typeof viewkey !== 'string') return null;
  const key = viewkey.trim().toLowerCase();
  if (!/^ph[0-9a-f]{8,}$/i.test(key)) return null;
  const pageUrl = `${WATCH_PAGE}${encodeURIComponent(key)}`;
  const res = await fetch(pageUrl, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });
  if (!res.ok) return null;
  const html = await res.text();
  const fromBlock = tryParseMediaDefinitionsBlock(html);
  const fromRe = regexVideoUrls(html);
  const merged = [...fromBlock, ...fromRe];
  if (merged.length === 0) return null;
  merged.sort((a, b) => b.q - a.q);
  return merged[0].url;
}
