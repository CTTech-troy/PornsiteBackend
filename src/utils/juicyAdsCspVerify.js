import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REQUIRED_DIRECTIVES = ['script-src', 'frame-src', 'connect-src'];
const JUICY_MARKERS = ['juicyads.com', 'jads.co', 'poweredby.jads.co'];

function readNetlifyToml() {
  const candidates = [
    join(__dirname, '../../../frontend/netlify.toml'),
    join(process.cwd(), 'frontend/netlify.toml'),
    join(process.cwd(), '../frontend/netlify.toml'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return { path: p, content: readFileSync(p, 'utf8') };
  }
  return { path: null, content: '' };
}

function readPublicHeaders() {
  const candidates = [
    join(__dirname, '../../../frontend/public/_headers'),
    join(process.cwd(), 'frontend/public/_headers'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return { path: p, content: readFileSync(p, 'utf8') };
  }
  return { path: null, content: '' };
}

function extractCsp(content) {
  const quoted = content.match(/Content-Security-Policy\s*=\s*"([^"]+)"/);
  if (quoted?.[1]) return quoted[1];
  const headersBlock = content.match(/Content-Security-Policy:\s*(.+)/i);
  return headersBlock?.[1]?.trim() || '';
}

function directiveAllowsJuicy(csp, directive) {
  const re = new RegExp(`${directive}\\s+([^;]+)`, 'i');
  const block = csp.match(re)?.[1] || '';
  return JUICY_MARKERS.some((m) => block.includes(m));
}

export function verifyJuicyAdsCspPolicy() {
  const toml = readNetlifyToml();
  const headers = readPublicHeaders();
  const csp = extractCsp(toml.content) || extractCsp(headers.content);

  if (!csp) {
    return {
      pass: false,
      detail: 'No Content-Security-Policy found in frontend/netlify.toml or frontend/public/_headers',
      sources: { toml: toml.path, headers: headers.path },
    };
  }

  const missing = REQUIRED_DIRECTIVES.filter((d) => !directiveAllowsJuicy(csp, d));
  const pass = missing.length === 0;

  return {
    pass,
    detail: pass
      ? `JuicyAds allowed in script-src, frame-src, connect-src (${toml.path ? 'netlify.toml' : '_headers'})`
      : `CSP missing safe JuicyAds hosts in: ${missing.join(', ')}. Add juicyads.com, js.juicyads.com, poweredby.jads.co, *.jads.co`,
    sources: { toml: toml.path, headers: headers.path },
  };
}
