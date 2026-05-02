export const LEVEL_CONFIG = {
  1: {
    name: 'Beginner Creator',
    premiumUploadLimit: 5,
    minFollowers: 0,
    minLikes: 0,
    color: 'gray',
  },
  2: {
    name: 'Growing Creator',
    premiumUploadLimit: 15,
    minFollowersOr: 1000,
    minLikesOr: 1000,
    color: 'blue',
  },
  3: {
    name: 'Advanced Creator',
    premiumUploadLimit: -1, // -1 = unlimited
    minFollowers: 10000,
    color: 'amber',
  },
};

/** Level 1 → Beginner, 2 → Growing, 3 → Advanced */
export function calculateCreatorLevel(followers, likes) {
  const f = Number(followers) || 0;
  const l = Number(likes) || 0;
  if (f >= 10000) return 3;
  if (f >= 1000 || l >= 1000) return 2;
  return 1;
}

/** -1 means unlimited */
export function getPremiumUploadLimit(level) {
  return LEVEL_CONFIG[level]?.premiumUploadLimit ?? 5;
}

/** Returns "YYYY-MM" string for the current UTC month */
export function getCurrentMonth() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
