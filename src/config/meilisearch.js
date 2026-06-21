import { MeiliSearch } from 'meilisearch';

let client = null;
const ensuredIndexes = new Set();

export const MEILI_INDEXES = {
  videos: process.env.MEILISEARCH_VIDEOS_INDEX || 'videos',
  creators: process.env.MEILISEARCH_CREATORS_INDEX || 'creators',
  users: process.env.MEILISEARCH_USERS_INDEX || 'users',
  liveStreams: process.env.MEILISEARCH_LIVE_STREAMS_INDEX || 'live_streams',
  tags: process.env.MEILISEARCH_TAGS_INDEX || 'tags',
  categories: process.env.MEILISEARCH_CATEGORIES_INDEX || 'categories',
};

export const VIDEOS_INDEX = MEILI_INDEXES.videos;

const INDEX_SETTINGS = {
  [MEILI_INDEXES.videos]: {
    primaryKey: 'id',
    searchableAttributes: ['title', 'description', 'tags', 'categories', 'creatorDisplayName', 'provider'],
    filterableAttributes: ['isPremiumContent', 'accessType', 'premiumVisibility', 'officialCompanyContent', 'contentSource', 'playable', 'deleted', 'creatorId', 'tags', 'categories'],
    sortableAttributes: ['createdAt', 'viewsCount', 'likesCount', 'commentsCount', 'engagementScore', 'trendingScore'],
    rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness', 'trendingScore:desc', 'viewsCount:desc', 'likesCount:desc', 'createdAt:desc'],
    typoTolerance: { enabled: true },
  },
  [MEILI_INDEXES.creators]: {
    primaryKey: 'id',
    searchableAttributes: ['displayName', 'username', 'bio', 'creatorType', 'tags'],
    filterableAttributes: ['active', 'status', 'creatorType', 'verified'],
    sortableAttributes: ['followers', 'totalViews', 'totalLikes', 'popularityScore', 'createdAt', 'updatedAt'],
    rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness', 'popularityScore:desc', 'followers:desc'],
    typoTolerance: { enabled: true },
  },
  [MEILI_INDEXES.users]: {
    primaryKey: 'id',
    searchableAttributes: ['displayName', 'username', 'email'],
    filterableAttributes: ['role', 'status', 'creator', 'verified'],
    sortableAttributes: ['createdAt', 'followers', 'updatedAt'],
    typoTolerance: { enabled: true },
  },
  [MEILI_INDEXES.liveStreams]: {
    primaryKey: 'id',
    searchableAttributes: ['title', 'hostDisplayName', 'hostId'],
    filterableAttributes: ['status', 'hostId'],
    sortableAttributes: ['startedAt', 'createdAt', 'viewersCount', 'totalLikes', 'totalGiftsAmount', 'trendingScore'],
    rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness', 'trendingScore:desc', 'viewersCount:desc'],
    typoTolerance: { enabled: true },
  },
  [MEILI_INDEXES.tags]: {
    primaryKey: 'id',
    searchableAttributes: ['name', 'normalizedName'],
    filterableAttributes: ['type'],
    sortableAttributes: ['count', 'trendingScore', 'updatedAt'],
    rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness', 'trendingScore:desc', 'count:desc'],
    typoTolerance: { enabled: true },
  },
  [MEILI_INDEXES.categories]: {
    primaryKey: 'id',
    searchableAttributes: ['name', 'normalizedName'],
    filterableAttributes: ['type'],
    sortableAttributes: ['count', 'trendingScore', 'updatedAt'],
    rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness', 'trendingScore:desc', 'count:desc'],
    typoTolerance: { enabled: true },
  },
};

export function getMeilisearchClient() {
  if (client) return client;
  const host = process.env.MEILISEARCH_HOST || process.env.MEILI_HOST || '';
  const apiKey = process.env.MEILISEARCH_API_KEY || process.env.MEILI_MASTER_KEY || process.env.MEILI_API_KEY || '';
  if (!host) return null;
  client = new MeiliSearch({ host: host.replace(/\/$/, ''), apiKey: apiKey || undefined });
  return client;
}

export function isMeilisearchConfigured() {
  return Boolean(getMeilisearchClient());
}

export function getMeilisearchPublicConfig() {
  return {
    host: process.env.MEILISEARCH_PUBLIC_HOST || process.env.MEILISEARCH_HOST || '',
    searchKey: process.env.MEILISEARCH_SEARCH_API_KEY || '',
    indexes: { ...MEILI_INDEXES },
  };
}

export function getIndexSettings(indexName) {
  return INDEX_SETTINGS[indexName];
}

async function waitForTask(ms, task) {
  const taskUid = task?.taskUid ?? task?.uid;
  if (taskUid == null || typeof ms.waitForTask !== 'function') return task;
  try {
    return await ms.waitForTask(taskUid, { timeOutMs: 15000, intervalMs: 200 });
  } catch {
    return task;
  }
}

export async function ensureIndex(indexName, { force = false } = {}) {
  const ms = getMeilisearchClient();
  if (!ms) return false;
  const settings = getIndexSettings(indexName);
  if (!settings) throw new Error(`Unknown Meilisearch index: ${indexName}`);
  if (!force && ensuredIndexes.has(indexName)) return true;
  try {
    await ms.createIndex(indexName, { primaryKey: settings.primaryKey });
  } catch {
    // Existing indexes raise an error; settings are still updated below.
  }
  const index = ms.index(indexName);
  const { primaryKey, ...indexSettings } = settings;
  await waitForTask(ms, await index.updateSettings(indexSettings));
  ensuredIndexes.add(indexName);
  return true;
}

export async function ensureVideosIndex() {
  return ensureIndex(MEILI_INDEXES.videos);
}

export async function ensureAllIndexes() {
  const ms = getMeilisearchClient();
  if (!ms) return false;
  for (const indexName of Object.values(MEILI_INDEXES)) {
    await ensureIndex(indexName);
  }
  return true;
}

export async function getMeilisearchHealth() {
  const ms = getMeilisearchClient();
  if (!ms) return { configured: false, available: false };
  try {
    const health = typeof ms.health === 'function'
      ? await ms.health()
      : await fetch(`${ms.config.host}/health`).then((res) => res.json());
    return { configured: true, available: health?.status === 'available', health };
  } catch (err) {
    return { configured: true, available: false, error: err?.message || String(err) };
  }
}
