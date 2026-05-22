export interface PermissionPage {
  key: string;
  label: string;
  path: string;
  group: string;
}

export const ALL_PAGES: PermissionPage[] = [
  { key: 'dashboard', label: 'Dashboard', path: '/', group: 'Main' },
  { key: 'users', label: 'Users', path: '/users', group: 'Users' },
  { key: 'creators', label: 'Creators', path: '/creators', group: 'Users' },
  { key: 'creator_applications', label: 'Creator Applications', path: '/creator-applications', group: 'Users' },
  { key: 'videos', label: 'Videos', path: '/videos', group: 'Content' },
  { key: 'premium_videos', label: 'Premium Videos', path: '/premium-videos', group: 'Content' },
  { key: 'live_sessions', label: 'Live Sessions', path: '/live-sessions', group: 'Content' },
  { key: 'random_sessions', label: 'Random Sessions', path: '/random-sessions', group: 'Content' },
  { key: 'ai_moderator', label: 'AI Moderator', path: '/ai-moderator', group: 'Moderation' },
  { key: 'finance_hub', label: 'Finance Hub', path: '/finance-hub', group: 'Finance' },
  { key: 'membership_plans', label: 'Membership Plans', path: '/membership-plans', group: 'Finance' },
  { key: 'coin_management', label: 'Coin Management', path: '/coin-management', group: 'Finance' },
  { key: 'payments', label: 'Payments', path: '/payments', group: 'Finance' },
  { key: 'creator_payouts', label: 'Creator Payouts', path: '/creator-payouts', group: 'Finance' },
  { key: 'ads_management', label: 'Ads Management', path: '/ads-management', group: 'Finance & Ads' },
  { key: 'audit_logs', label: 'Audit Logs', path: '/audit-logs', group: 'System' },
  { key: 'admin_roles', label: 'Admin Roles', path: '/admin-roles', group: 'System' },
  { key: 'settings', label: 'Settings', path: '/settings', group: 'System' },
  { key: 'external_feed', label: 'External Feed', path: '/external-feed', group: 'System' },
  { key: 'env_settings', label: 'Env Settings', path: '/env-settings', group: 'System' },
  { key: 'it_operations', label: 'IT Operations', path: '/it-operations', group: 'System' },
  { key: 'terms_policy', label: 'Terms & Policy', path: '/terms-policy', group: 'System' },
];

export const PAGE_GROUPS = [...new Set(ALL_PAGES.map(p => p.group))];

export function buildPermissionsFromKeys(keys: string[]): string[] {
  return ALL_PAGES.filter(p => keys.includes(p.key)).map(p => p.path);
}

export function getPageByPath(path: string): PermissionPage | undefined {
  return ALL_PAGES.find(p => p.path === path);
}
