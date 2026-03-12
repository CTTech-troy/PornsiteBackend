import pornhub from '@justalk/pornhub-api';

/**
 * Get detailed information for a single Pornhub video page.
 * @param {string} url - Full Pornhub video URL.
 * @returns {Promise<object>}
 */
export async function getVideoInfo(url) {
  if (!url) {
    throw new Error('Missing Pornhub video URL');
  }

  // You can add/remove keys depending on what you need
  const keys = ['title', 'pornstars', 'download_urls', 'duration', 'views', 'categories'];

  return pornhub.page(url, keys);
}

/**
 * Text search on Pornhub.
 * @param {string} query - Search text.
 * @param {object} opts
 * @param {number} [opts.page=1] - Page number.
 * @param {string} [opts.sort='mr'] - Sort order (e.g. 'mr' for most recent, depends on library docs).
 * @returns {Promise<object>}
 */
export async function searchVideos(query, { page = 1, sort = 'mr' } = {}) {
  if (!query) {
    throw new Error('Missing search query');
  }

  const keys = ['title', 'url', 'duration', 'views', 'premium', 'thumb'];

  const options = [
    { key: 'page', value: page },
    { key: 'o', value: sort },
  ];

  return pornhub.search(query, keys, options);
}

/**
 * Search videos by category / filters.
 * @param {object} params
 * @param {string} params.category - Category slug (e.g. 'teen', 'milf', etc.).
 * @param {number} [params.page=1]
 * @param {object} [params.filters={}] - Extra raw options to pass through.
 * @returns {Promise<object>}
 */
export async function searchByCategory({ category, page = 1, filters = {} } = {}) {
  if (!category) {
    throw new Error('Missing category');
  }

  const keys = ['title', 'url', 'duration', 'premium', 'thumb'];

  const options = [
    { key: 'c', value: category },
    { key: 'page', value: page },
    // Spread any extra filters, e.g. { hd: '1' }
    ...Object.entries(filters).map(([key, value]) => ({ key, value })),
  ];

  return pornhub.video(keys, options);
}

/**
 * Get a Pornhub model / pornstar page information.
 * @param {string} name - Model name as it appears in Pornhub URL.
 * @param {'pornstar'|'model'} [type='pornstar']
 * @returns {Promise<object>}
 */
export async function getModelInfo(name, type = 'pornstar') {
  if (!name) {
    throw new Error('Missing model name');
  }

  const keys = ['name', 'videos', 'profileUrl', 'categories', 'views', 'subscribers'];

  return pornhub.model(name, keys, type);
}

