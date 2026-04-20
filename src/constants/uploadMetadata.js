export const MAIN_ORIENTATION_CATEGORIES = [
  'Straight',
  'Gay',
  'Lesbian',
  'Trans',
  'Bisexual',
  'Other',
];

export const DEFAULT_MAIN_ORIENTATION_CATEGORY = 'Straight';

export const MAX_UPLOAD_TITLE_LENGTH = 100;
export const MAX_UPLOAD_DESCRIPTION_LENGTH = 2000;
export const MAX_UPLOAD_TAGS = 20;

export function normalizeMainOrientationCategory(value) {
  const v = String(value || '').trim();
  return MAIN_ORIENTATION_CATEGORIES.includes(v) ? v : DEFAULT_MAIN_ORIENTATION_CATEGORY;
}

export function normalizeTags(input) {
  if (!input) return [];
  const arr = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[,\s]+/)
      : [];
  return [...new Set(arr.map(t => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, MAX_UPLOAD_TAGS);
}

export function normalizeAllowPeopleToComment(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value !== 'false' && value !== '0';
  return true;
}

export function normalizeTitle(value) {
  return String(value || '').trim().slice(0, MAX_UPLOAD_TITLE_LENGTH);
}

export function normalizeDescription(value) {
  return String(value || '').trim().slice(0, MAX_UPLOAD_DESCRIPTION_LENGTH);
}

export function getDescriptionFallback(title) {
  const t = normalizeTitle(title);
  return t ? `Watch ${t}` : '';
}
