import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboardIcon, UsersIcon, VideoIcon,
  CreditCardIcon, SettingsIcon, XIcon, PlaySquareIcon, RadioIcon,
  ShuffleIcon, StarIcon, UserCheckIcon, FileTextIcon, DollarSignIcon,
  ShieldIcon, LogOutIcon, BotIcon, PieChartIcon,
  FileCheckIcon, MegaphoneIcon, ServerIcon, LockIcon, RssIcon, CoinsIcon,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';

interface SidebarProps {
  isOpen: boolean;
  setIsOpen: (v: boolean) => void;
}

const NAV = [
  {
    title: 'Main',
    items: [{ name: 'Dashboard', path: '/', icon: LayoutDashboardIcon }],
  },
  {
    title: 'Content',
    items: [
      { name: 'Videos', path: '/videos', icon: VideoIcon },
      { name: 'Premium Videos', path: '/premium-videos', icon: PlaySquareIcon },
      { name: 'Live Sessions', path: '/live-sessions', icon: RadioIcon },
      { name: 'Random 1-on-1', path: '/random-sessions', icon: ShuffleIcon },
    ],
  },
  {
    title: 'Users',
    items: [
      { name: 'Users', path: '/users', icon: UsersIcon },
      { name: 'Creators', path: '/creators', icon: StarIcon },
      { name: 'Applications', path: '/creator-applications', icon: UserCheckIcon },
    ],
  },
  {
    title: 'Moderation',
    items: [
      { name: 'Content Removal', path: '/content-removal', icon: FileCheckIcon },
    ],
  },
  {
    title: 'AI Moderation',
    items: [
      { name: 'AI Overview', path: '/ai-moderator?tab=overview', icon: BotIcon },
      { name: 'Live Monitoring', path: '/ai-moderator?tab=live', icon: RadioIcon },
      { name: 'Incidents', path: '/ai-moderator?tab=incidents', icon: ShieldIcon },
      { name: 'AI Analytics', path: '/ai-moderator?tab=analytics', icon: PieChartIcon },
      { name: 'Fraud Detection', path: '/ai-moderator?tab=fraud', icon: DollarSignIcon },
      { name: 'Training Center', path: '/ai-moderator?tab=training', icon: SettingsIcon },
      { name: 'Infrastructure', path: '/ai-moderator?tab=infra', icon: ServerIcon },
    ],
  },
  {
    title: 'Finance & Ads',
    items: [
      { name: 'Finance Hub', path: '/finance-hub', icon: PieChartIcon },
      { name: 'Membership Plans', path: '/membership-plans', icon: FileTextIcon },
      { name: 'Coin Management', path: '/coin-management', icon: CoinsIcon },
      { name: 'Payments', path: '/payments', icon: CreditCardIcon },
      { name: 'Creator Payouts', path: '/creator-payouts', icon: DollarSignIcon },
      { name: 'Ads Management', path: '/ads-management', icon: MegaphoneIcon },
    ],
  },
  {
    title: 'System & IT',
    items: [
      { name: 'IT Operations', path: '/it-operations', icon: ServerIcon },
      { name: 'Env Settings', path: '/env-settings', icon: LockIcon },
      { name: 'Audit Logs', path: '/audit-logs', icon: FileTextIcon },
      { name: 'Admin Roles', path: '/admin-roles', icon: ShieldIcon },
      { name: 'Terms & Policy', path: '/terms-policy', icon: FileCheckIcon },
      { name: 'External Feed', path: '/external-feed', icon: RssIcon },
      { name: 'Settings', path: '/settings', icon: SettingsIcon },
    ],
  },
];

function initials(user: any) {
  const name = String(user?.name || '').trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    const letters = parts.slice(0, 2).map((p: string) => p[0]?.toUpperCase() || '').join('');
    if (letters) return letters;
  }
  return String(user?.email || 'AD').slice(0, 2).toUpperCase();
}

export default function Sidebar({ isOpen, setIsOpen }: SidebarProps) {
  const { hasPermission, user, logout } = useAuth();
  const roleLabel = user?.is_super_admin ? 'Super Admin' : 'Admin';

  return (
    <>
      {/* Mobile backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={() => setIsOpen(false)}
        />
      )}

      <aside
        className={`
          fixed inset-y-0 left-0 z-50 w-60 flex flex-col
          bg-bg-base border-r border-border-default
          transition-transform duration-200 ease-out
          lg:static lg:translate-x-0
          ${isOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
      >
        {/* Logo */}
        <div className="flex h-14 shrink-0 items-center justify-between px-5 border-b border-border-default">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-white flex items-center justify-center shrink-0">
              <PlaySquareIcon className="w-4 h-4 text-black" strokeWidth={2.5} />
            </div>
            <span className="text-[15px] font-semibold text-text-primary tracking-tight">Xstream</span>
          </div>
          <button
            onClick={() => setIsOpen(false)}
            className="lg:hidden p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        {/* Nav */}
        <div className="flex-1 overflow-y-auto custom-scrollbar py-4">
          <nav className="px-3 space-y-5">
            {NAV.map((section) => {
              const visible = section.items.filter(i => hasPermission(i.path));
              if (!visible.length) return null;
              return (
                <div key={section.title}>
                  <p className="px-2.5 mb-1.5 text-[10px] font-semibold tracking-widest uppercase text-text-tertiary select-none">
                    {section.title}
                  </p>
                  <div className="space-y-0.5">
                    {visible.map((item) => {
                      const Icon = item.icon;
                      return (
                        <NavLink
                          key={item.name}
                          to={item.path}
                          onClick={() => setIsOpen(false)}
                          className={({ isActive }) =>
                            `group flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-[13px] font-medium transition-colors duration-150 ${
                              isActive
                                ? 'bg-bg-elevated text-text-primary'
                                : 'text-text-secondary hover:text-text-primary hover:bg-bg-elevated'
                            }`
                          }
                        >
                          {({ isActive }) => (
                            <>
                              <Icon
                                className={`w-4 h-4 shrink-0 transition-colors ${
                                  isActive ? 'text-text-primary' : 'text-text-tertiary group-hover:text-text-secondary'
                                }`}
                              />
                              {item.name}
                            </>
                          )}
                        </NavLink>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </nav>
        </div>

        {/* User card */}
        <div className="shrink-0 p-3 border-t border-border-default">
          <div className="flex items-center gap-3 px-2.5 py-2 rounded-md">
            <div className="w-7 h-7 rounded-full bg-bg-elevated border border-border-strong flex items-center justify-center shrink-0">
              <span className="text-[11px] font-semibold text-text-secondary">{initials(user)}</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-medium text-text-primary truncate">{user?.name || 'Admin'}</p>
              <p className="text-[11px] text-text-tertiary">{roleLabel}</p>
            </div>
            <button
              onClick={logout}
              title="Sign out"
              className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors shrink-0"
            >
              <LogOutIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
