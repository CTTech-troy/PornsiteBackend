import React, { useState } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { LayoutDashboard, Users, Video, Menu } from 'lucide-react';
import Sidebar from './Sidebar';
import TopNavbar from './TopNavbar';
import { useAuth } from '../../contexts/AuthContext';

const BOTTOM_NAV = [
  { name: 'Dashboard', path: '/', icon: LayoutDashboard },
  { name: 'Users', path: '/users', icon: Users },
  { name: 'Videos', path: '/videos', icon: Video },
];

export default function DashboardLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { hasPermission } = useAuth();
  const location = useLocation();
  const navItems = BOTTOM_NAV.filter(i => hasPermission(i.path));

  return (
    <div className="flex h-[100dvh] bg-bg-base overflow-hidden">
      <Sidebar isOpen={sidebarOpen} setIsOpen={setSidebarOpen} />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <TopNavbar onMenuClick={() => setSidebarOpen(true)} />

        <main className="flex-1 overflow-y-auto custom-scrollbar">
          <div className="max-w-[1280px] mx-auto px-4 lg:px-8 py-6 pb-24 lg:pb-8">
            <Outlet />
          </div>
        </main>
      </div>

      {/* Mobile bottom nav */}
      <div className="lg:hidden fixed bottom-0 inset-x-0 bg-bg-surface/90 backdrop-blur-xl border-t border-border-default z-40">
        <div className="flex items-center h-14 px-2 safe-pb">
          {navItems.map(({ name, path, icon: Icon }) => {
            const active = location.pathname === path || (path !== '/' && location.pathname.startsWith(path));
            return (
              <NavLink
                key={name}
                to={path}
                className={`flex flex-col items-center justify-center flex-1 h-full gap-1 transition-colors ${
                  active ? 'text-text-primary' : 'text-text-tertiary hover:text-text-secondary'
                }`}
              >
                <Icon className="w-5 h-5" />
                <span className="text-[10px] font-medium">{name}</span>
              </NavLink>
            );
          })}
          <button
            onClick={() => setSidebarOpen(true)}
            className="flex flex-col items-center justify-center flex-1 h-full gap-1 text-text-tertiary hover:text-text-secondary transition-colors"
          >
            <Menu className="w-5 h-5" />
            <span className="text-[10px] font-medium">More</span>
          </button>
        </div>
      </div>
    </div>
  );
}
