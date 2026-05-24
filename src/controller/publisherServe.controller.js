import {
  resolveServeCreative,
  buildBannerHtml,
  buildJsEmbed,
} from '../services/publisherAdServe.service.js';
import { trackPublisherEvent } from '../services/publisherTracking.service.js';
import { getPartnerByCode } from '../services/publisherPartner.service.js';
import { attributeReferral } from '../services/publisherRevenue.service.js';

const PLACEHOLDER_SVG = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="300" height="250"%3E%3Crect fill="%231a1a2e" width="300" height="250"/%3E%3Ctext x="50%25" y="50%25" fill="%23FF4654" font-size="14" text-anchor="middle" dy=".3em"%3EXstream%3C/text%3E%3C/svg%3E';

function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '';
}

export async function serveHtml(req, res) {
  try {
    const creative = await resolveServeCreative(req.params.token, { referer: req.headers.referer });
    if (!creative) return res.status(404).send('Ad not found');

    await trackPublisherEvent({
      eventType: 'impression',
      publicToken: req.params.token,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'],
      referrer: req.headers.referer,
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;padding:0;overflow:hidden;}</style></head><body>${buildBannerHtml(creative)}</body></html>`);
  } catch (err) {
    return res.status(500).send('Error');
  }
}

export async function serveImage(req, res) {
  try {
    const creative = await resolveServeCreative(req.params.token, { referer: req.headers.referer });
    if (!creative) return res.redirect(PLACEHOLDER_SVG);

    await trackPublisherEvent({
      eventType: 'impression',
      publicToken: req.params.token,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'],
      referrer: req.headers.referer,
    });

    if (creative.networkAd?.imageUrl) {
      return res.redirect(302, creative.networkAd.imageUrl);
    }
    return res.redirect(302, creative.platformUrl + '/favicon.ico');
  } catch {
    return res.redirect(PLACEHOLDER_SVG);
  }
}

export async function serveJs(req, res) {
  try {
    const token = req.params.token;
    const base = `${req.protocol}://${req.get('host')}`;
    const js = buildJsEmbed(token, base);
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    return res.send(js);
  } catch {
    return res.status(500).send('');
  }
}

export async function clickRedirect(req, res) {
  try {
    const creative = await resolveServeCreative(req.params.token, { referer: req.headers.referer });
    if (!creative) return res.redirect(process.env.PUBLIC_SITE_URL || '/');

    await trackPublisherEvent({
      eventType: 'click',
      publicToken: req.params.token,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'],
      referrer: req.headers.referer,
    });

    const dest = creative.networkAd?.clickUrl
      || creative.destUrl
      || creative.platformUrl
      || process.env.PUBLIC_SITE_URL
      || 'https://xstreamvideos.site';
    return res.redirect(302, dest);
  } catch {
    return res.redirect(process.env.PUBLIC_SITE_URL || '/');
  }
}

export async function referralRedirect(req, res) {
  try {
    const code = req.params.partnerCode;
    const partner = await getPartnerByCode(code);
    const site = process.env.PUBLIC_SITE_URL || 'https://xstreamvideos.site';
    const path = req.query.to || '/';
    const dest = `${site}${path.startsWith('/') ? path : `/${path}`}`;

    res.setHeader('Set-Cookie', `xs_ref=${encodeURIComponent(code)}; Max-Age=${30 * 86400}; Path=/; SameSite=Lax`);
    await attributeReferral({ partnerCode: code, referralType: 'user', landingPath: path });

    return res.redirect(302, `${dest}${dest.includes('?') ? '&' : '?'}ref=${encodeURIComponent(code)}`);
  } catch {
    return res.redirect(process.env.PUBLIC_SITE_URL || '/');
  }
}

export async function trackImpression(req, res) {
  try {
    const result = await trackPublisherEvent({
      eventType: 'impression',
      publicToken: req.body?.token || req.params.token,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'],
      referrer: req.body?.referrer || req.headers.referer,
      geo: req.body?.geo,
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, message: err?.message });
  }
}

export async function trackClick(req, res) {
  try {
    const result = await trackPublisherEvent({
      eventType: 'click',
      publicToken: req.body?.token || req.params.token,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'],
      referrer: req.body?.referrer || req.headers.referer,
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, message: err?.message });
  }
}
