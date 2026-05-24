import { getPlatformSettingsMap } from './platformSettings.service.js';
import { getEmbedByToken } from './publisherPartner.service.js';
import { getNetworkCampaign } from './adCampaign.service.js';

const SIZE_MAP = {
  '300x250': { w: 300, h: 250 },
  '728x90': { w: 728, h: 90 },
  '160x600': { w: 160, h: 600 },
  '320x50': { w: 320, h: 50 },
  '970x250': { w: 970, h: 250 },
  '120x150': { w: 120, h: 150 },
};

export function parseSize(size) {
  return SIZE_MAP[size] || { w: 300, h: 250 };
}

export async function resolveServeCreative(publicToken, { referer, excludeCampaignId = null } = {}) {
  const embed = await getEmbedByToken(publicToken);
  if (!embed) return null;

  const unit = embed.publisher_ad_units;
  const partner = unit?.publisher_partners;
  if (!unit || unit.status !== 'active') return null;

  const allowed = embed.allowed_domains || [];
  if (allowed.length && referer) {
    try {
      const host = new URL(referer).hostname.replace(/^www\./, '');
      const ok = allowed.some((d) => host === d || host.endsWith(`.${d}`));
      if (!ok) return null;
    } catch { /* allow if referer unparseable */ }
  }

  const { w, h } = parseSize(unit.size);
  const settings = await getPlatformSettingsMap();
  const clickBase = process.env.PUBLIC_API_URL || process.env.API_BASE_URL || '';
  const networkAd = await getNetworkCampaign({ seed: publicToken, excludeId: excludeCampaignId });

  const destUrl = networkAd?.clickUrl
    || settings.platform_url
    || process.env.PUBLIC_SITE_URL
    || 'https://xstreamvideos.site';

  const imgUrl = networkAd?.imageUrl
    || `${clickBase.replace(/\/$/, '')}/api/publisher/serve/${publicToken}/image`;

  const clickUrl = networkAd?.id
    ? `${clickBase.replace(/\/$/, '')}/api/publisher/click/${publicToken}?campaignId=${encodeURIComponent(networkAd.id)}`
    : `${clickBase.replace(/\/$/, '')}/api/publisher/click/${publicToken}`;

  return {
    unit,
    partner,
    networkAd,
    width: networkAd?.width || w,
    height: networkAd?.height || h,
    clickUrl,
    imgUrl,
    destUrl,
    platformUrl: settings.platform_url || process.env.PUBLIC_SITE_URL || 'https://xstreamvideos.site',
    partnerCode: partner?.partner_code,
  };
}

export function buildBannerHtml(creative) {
  const { clickUrl, imgUrl, width, height, networkAd } = creative;
  if (networkAd?.embedHtml) {
    return `<div style="width:${width}px;height:${height}px;overflow:hidden;">${networkAd.embedHtml}</div>`;
  }
  return `<a href="${clickUrl}" target="_blank" rel="noopener sponsored"><img src="${imgUrl}" width="${width}" height="${height}" alt="Advertisement" border="0" style="display:block;max-width:100%;height:auto;"></a>`;
}

export function buildJsEmbed(publicToken, apiBase) {
  const base = apiBase.replace(/\/$/, '');
  return `(function(){var s=document.createElement('script');s.async=true;s.src='${base}/api/publisher/serve/${publicToken}.js';s.setAttribute('data-cfasync','false');(document.head||document.body).appendChild(s);})();`;
}
