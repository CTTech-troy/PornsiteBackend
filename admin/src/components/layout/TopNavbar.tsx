import React from 'react';
import { Link } from 'react-router-dom';
import { MenuIcon, BellIcon, SunIcon, MoonIcon } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useTheme } from '../../contexts/ThemeContext';

interface TopNavbarProps {
  onMenuClick: () => void;
}

function initials(user: any) {
  const name = String(user?.name || '').trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    const letters = parts.slice(0, 2).map((p: string) => p[0]?.toUpperCase() || '').join('');
    if (letters) return letters;
  }
  return String(user?.email || 'AD').slice(0, 2).toUpperCase();
}

export default function TopNavbar({ onMenuClick }: TopNavbarProps) {
  const { user } = useAuth();
  const { theme, toggleTheme } = useTheme();

  return (
    <header className="h-14 shrink-0 flex items-center justify-between px-4 lg:px-6 border-b border-border-default bg-bg-base sticky top-0 z-30 transition-colors duration-200">
      {/* Left */}
      <div className="flex items-center gap-3">
        <button
          onClick={onMenuClick}
          className="lg:hidden p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
          aria-label="Open navigation"
        >
          <MenuIcon className="w-5 h-5" />
        </button>

        {/* Page title slot — empty here, breadcrumbs live in pages */}
        <span className="hidden md:block text-[13px] font-medium text-text-tertiary select-none">
          XstreamVideos Admin
        </span>
      </div>

      {/* Right */}
      <div className="flex items-center gap-1">
        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          className="p-2 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
        >
          {theme === 'dark'
            ? <SunIcon className="w-4 h-4" />
            : <MoonIcon className="w-4 h-4" />
          }
        </button>

        {/* Notifications */}
        <button
          className="relative p-2 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
          aria-label="Notifications"
        >
          <BellIcon className="w-4 h-4" />
          <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-accent rounded-full" />
        </button>

        {/* Profile avatar */}
        <Link
          to="/profile"
          className="ml-1 w-7 h-7 rounded-full bg-bg-elevated border border-border-strong flex items-center justify-center text-[11px] font-semibold text-text-secondary hover:border-border-hover hover:text-text-primary transition-colors"
          aria-label="Profile"
        >
          {initials(user)}
        </Link>
      </div>
    </header>
  );
}
