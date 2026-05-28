import { getPublicSlotsConfig } from './adSlot.service.js';
import { listActiveCampaigns, mapCampaignRow, pickRotatedCampaign } from './adCampaign.service.js';
import { validateAdForRender } from './safeAdPolicy.service.js';

const FEED_NATIVE_PLACEMENTS = new Set(['feed_native', 'category_feed', 'mobile_inline', 'native_card', 'feed']);

function numberFrom(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function normalizeDevice(value, userAgent = '') {
  const raw = String(value || '').toLowerCase();
  if (['desktop', 'tablet', 'mobile'].includes(raw)) return raw;
  const ua = String(userAgent || '').toLowerCase();
  if (/ipad|tablet/.test(ua)) return 'tablet';
  if (/mobile|android|iphone|ipod/.test(ua)) return 'mobile';
  return 'desktop';
}

function getSlotConfig(slot) {
  const raw = slot?.config || slot?.zoneConfig || {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' ? raw : {};
}

function getVideoIdentity(video, index = 0) {
  if (!video || typeof video !== 'object') return `index:${index}`;
  const id = video.id ?? video.videoId ?? video.video_id ?? video.key ?? video.viewkey ?? video.viewKey;
  if (id != null && String(id).trim()) return `id:${String(id).trim()}`;
  const url = video.videoSrc ?? video.videoUrl ?? video.video_url ?? video.url ?? video.link ?? video.pageUrl ?? video.thumbnail;
  if (url != null && String(url).trim()) return `url:${String(url).trim()}`;
  const title = String(video.title || '').trim().toLowerCase();
  return title ? `title:${title}` : `index:${index}`;
}

function isNativeFeedSlot(slot) {
  const placement = String(slot?.placementType || slot?.placement || '').toLowerCase();
  const location = String(slot?.location || '').toLowerCase();
  return FEED_NATIVE_PLACEMENTS.has(placement) || FEED_NATIVE_PLACEMENTS.has(location);
}

function buildRule(slot) {
  const config = getSlotConfig(slot);
  const frequency = numberFrom(
    config.insertion_frequency,
    config.insertionFrequency,
    config.frequency,
    config.every,
    slot.frequencyCap,
  );
  if (!frequency) return null;
  const startAfter = numberFrom(config.start_after, config.startAfter) || frequency;
  const maxPerPage = numberFrom(config.max_per_page, config.maxPerPage, config.max) || 4;
  return {
    frequency,
    startAfter,
    maxPerPage,
    slot,
    priority: Number(slot.priority || 100),
  };
}

function safeFormatForCreative(ad, placement) {
  const raw = String(ad?.creativeType || ad?.sourceType || '').toLowerCase();
  if (FEED_NATIVE_PLACEMENTS.has(String(placement || '')) || raw.includes('native')) return 'native';
  if (raw.includes('vast') || raw.includes('video')) return 'video';
  return 'display';
}

function shouldInjectAfter(videoCount, rule) {
  if (!rule || videoCount < rule.startAfter) return false;
  return ((videoCount - rule.startAfter) % rule.frequency) === 0;
}

async function creativeForSlot(slot, seed) {
  const placement = String(slot.placementType || slot.placement || 'feed_native').toLowerCase();
  const rows = await listActiveCampaigns(placement);
  const slotRows = rows.filter((row) => !row.slot_key || row.slot_key === slot.slotKey);
  const picked = pickRotatedCampaign(slotRows.length ? slotRows : rows, { seed });
  const campaign = mapCampaignRow(picked);
  if (campaign) {
    const creative = {
      ...campaign,
      placement,
      placementType: placement,
      slotKey: slot.slotKey,
      width: campaign.width || slot.width,
      height: campaign.height || slot.height,
      adSize: campaign.adSize || slot.sizeLabel || `${slot.width}x${slot.height}`,
    };
    const check = await validateAdForRender({
      placement,
      width: creative.width || slot.width,
      height: creative.height || slot.height,
      embedHtml: creative.embedHtml,
      providerSlug: creative.providerSlug || 'custom',
      format: safeFormatForCreative(creative, placement),
    });
    if (!check.ok) {
      console.warn('[feed-layout] campaign rejected by safe ad policy', {
        slotKey: slot.slotKey,
        placement,
        adId: campaign.id,
        reason: check.reason,
      });
      return null;
    }
    return creative;
  }
  if (slot.embedCode) {
    const check = await validateAdForRender({
      placement,
      width: slot.width,
      height: slot.height,
      embedHtml: slot.embedCode,
      providerSlug: slot.providerId || 'custom',
      format: safeFormatForCreative({ creativeType: 'embed' }, placement),
    });
    if (!check.ok) {
      console.warn('[feed-layout] slot embed rejected by safe ad policy', {
        slotKey: slot.slotKey,
        placement,
        reason: check.reason,
      });
      return null;
    }
    return {
      id: `slot-embed:${slot.slotKey}`,
      title: slot.name || 'Sponsored',
      description: '',
      imageUrl: null,
      clickUrl: null,
      placement,
      placementType: placement,
      slotKey: slot.slotKey,
      creativeType: 'embed',
      sourceType: 'embed',
      embedHtml: slot.embedCode,
      ctaText: 'Learn More',
      width: slot.width,
      height: slot.height,
      adSize: slot.sizeLabel || `${slot.width}x${slot.height}`,
      networkVisible: false,
      ownership: 'platform',
      paymentStatus: 'waived',
    };
  }
  return null;
}

function buildAdItem({ slot, creative, sequence, afterVideoKey }) {
  const placement = String(slot.placementType || slot.placement || 'feed_native').toLowerCase();
  return {
    type: 'ad',
    key: `ad:${slot.slotKey}:${sequence}:${afterVideoKey}`,
    slotKey: slot.slotKey,
    slotIndex: sequence,
    placement,
    placementType: placement,
    label: 'Ads',
    size: {
      label: slot.sizeLabel || `${slot.width}x${slot.height}`,
      width: Number(slot.width) || 300,
      height: Number(slot.height) || 250,
    },
    ad: creative,
  };
}

export async function buildStructuredFeedLayout({
  videos = [],
  req = null,
  pageKey = 'home',
  category = '',
  seed = '',
} = {}) {
  const device = normalizeDevice(req?.query?.device, req?.headers?.['user-agent']);
  const publicPage = pageKey === 'category' ? 'category' : pageKey;
  const config = await getPublicSlotsConfig({ page: publicPage, device });
  if (!config.enabled) {
    return { items: videos.map((video, index) => ({ type: 'video', key: `video:${getVideoIdentity(video, index)}`, video, index })), meta: { device, adSlots: [], rules: [] } };
  }

  const rules = (config.slots || [])
    .filter(isNativeFeedSlot)
    .map(buildRule)
    .filter(Boolean)
    .sort((a, b) => a.priority - b.priority);

  if (!rules.length) {
    return { items: videos.map((video, index) => ({ type: 'video', key: `video:${getVideoIdentity(video, index)}`, video, index })), meta: { device, adSlots: [], rules: [] } };
  }

  const creativeBySlot = new Map();
  await Promise.all(rules.map(async (rule) => {
    const creative = await creativeForSlot(rule.slot, `${seed}:${category}:${rule.slot.slotKey}`);
    if (creative) creativeBySlot.set(rule.slot.slotKey, creative);
  }));

  const injectedBySlot = new Map();
  const items = [];
  for (let index = 0; index < videos.length; index += 1) {
    const video = videos[index];
    const videoKey = getVideoIdentity(video, index);
    items.push({ type: 'video', key: `video:${videoKey}`, video, index });

    const videoCount = index + 1;
    for (const rule of rules) {
      const creative = creativeBySlot.get(rule.slot.slotKey);
      const injected = injectedBySlot.get(rule.slot.slotKey) || 0;
      if (!creative || injected >= rule.maxPerPage || !shouldInjectAfter(videoCount, rule)) continue;
      injectedBySlot.set(rule.slot.slotKey, injected + 1);
      items.push(buildAdItem({
        slot: rule.slot,
        creative,
        sequence: injected + 1,
        afterVideoKey: videoKey,
      }));
    }
  }

  const exposedRules = rules.map((rule) => ({
    slotKey: rule.slot.slotKey,
    placement: rule.slot.placementType || rule.slot.placement,
    frequency: rule.frequency,
    startAfter: rule.startAfter,
    maxPerPage: rule.maxPerPage,
    priority: rule.priority,
  }));

  console.log('[feed-layout] structured feed built', {
    pageKey,
    device,
    videoCount: videos.length,
    itemCount: items.length,
    adCount: items.filter((item) => item.type === 'ad').length,
    rules: exposedRules,
  });

  return {
    items,
    meta: {
      device,
      adSlots: [...creativeBySlot.keys()],
      rules: exposedRules,
    },
  };
}
