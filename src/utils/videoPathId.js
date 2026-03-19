/** Match frontend `getPathSafeVideoId` for route ids and cache keys. */
export function getPathSafeVideoId(id) {
  if (id == null) return '';
  const s = String(id).trim();
  const viewkeyMatch = s.match(/[?&]viewkey=([^&]+)/);
  if (viewkeyMatch) return viewkeyMatch[1];
  if (s.startsWith('http') || s.includes('/')) {
    const slug = s.replace(/^.*\//, '').split('?')[0];
    if (slug && slug.length < 80 && !slug.includes(':')) return slug;
    return encodeURIComponent(s).replace(/[!/#?$&'()*+,:;=@%]/g, '_').slice(0, 64);
  }
  return s.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 64) || s;
}
