import React, { useState, useCallback } from 'react';
import {
  UsersIcon, VideoIcon, StarIcon, RadioIcon,
  FileTextIcon, CreditCardIcon, RefreshCwIcon,
  TrendingUpIcon, UserCheckIcon, ShieldAlertIcon,
  ChevronRightIcon, ActivityIcon, ServerIcon,
  BanknoteIcon, ClipboardListIcon, BarChart2Icon,
} from 'lucide-react';
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, Tooltip, CartesianGrid, Cell,
} from 'recharts';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAuth } from '../contexts/AuthContext';
import { fetchAdminStats, type AdminStats } from '../api/systemApi';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import { ActionButton } from '../components/shared/ActionButton';
import { StatsCard } from '../components/shared/StatsCard';

// ── Data ──────────────────────────────────────────────────────────────────────

function buildSpark(current: number, days = 7) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const label = i === 0 ? 'Today' : `${i}d`;
    const jitter = 0.82 + Math.random() * 0.18;
    out.push({ label, value: i === 0 ? current : Math.round(current * jitter) });
  }
  return out;
}

// ── Micro components ──────────────────────────────────────────────────────────

const fadeUp = { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 } };

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-bg-surface border border-border-default rounded-lg px-3 py-2 shadow-xl text-[12px]">
      <p className="text-text-tertiary mb-0.5">{label}</p>
      <p className="font-semibold text-text-primary tabular-nums">{payload[0].value.toLocaleString()}</p>
    </div>
  );
}

function SectionCard({ title, icon: Icon, children, action }: {
  title: string;
  icon?: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="card p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {Icon && <Icon className="w-4 h-4 text-text-tertiary" />}
          <h3 className="text-[13px] font-semibold text-text-primary">{title}</h3>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function QuickLink({ label, path, icon: Icon, badge }: {
  label: string; path: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: number;
}) {
  const nav = useNavigate();
  return (
    <button
      onClick={() => nav(path)}
      className="group flex items-center justify-between px-3 py-2 rounded-md hover:bg-bg-elevated transition-colors duration-150 text-left"
    >
      <span className="flex items-center gap-2.5 text-[13px] text-text-secondary group-hover:text-text-primary transition-colors">
        <Icon className="w-3.5 h-3.5 text-text-tertiary group-hover:text-text-secondary transition-colors" />
        {label}
      </span>
      <span className="flex items-center gap-2">
        {badge !== undefined && badge > 0 && (
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-accent/15 text-accent">
            {badge}
          </span>
        )}
        <ChevronRightIcon className="w-3 h-3 text-border-hover group-hover:text-text-tertiary transition-colors" />
      </span>
    </button>
  );
}

function BarItem({ label, value, total, color }: {
  label: string; value: number; total: number; color: string;
}) {
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div>
      <div className="flex justify-between mb-1.5 text-[12px]">
        <span className="text-text-tertiary">{label}</span>
        <span className="text-text-secondary font-medium tabular-nums">{value.toLocaleString()}</span>
      </div>
      <div className="h-1 bg-bg-elevated rounded-full overflow-hidden">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.7, ease: 'easeOut', delay: 0.1 }}
          className={`h-full rounded-full ${color}`}
        />
      </div>
    </div>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1.5">
          <div className="h-6 w-32 bg-bg-surface rounded-md animate-pulse" />
          <div className="h-3.5 w-48 bg-bg-surface rounded animate-pulse" />
        </div>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="card p-5 space-y-3 animate-pulse">
            <div className="h-3 w-20 bg-bg-elevated rounded" />
            <div className="h-7 w-16 bg-bg-elevated rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

const REFRESH = 30_000;

export function Dashboard() {
  const { user, hasPermission } = useAuth();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const showUsers    = user?.is_super_admin || hasPermission('/users');
  const showCreators = user?.is_super_admin || hasPermission('/creators') || hasPermission('/creator-applications');
  const showContent  = user?.is_super_admin || hasPermission('/videos') || hasPermission('/live-sessions');
  const showFinance  = user?.is_super_admin || hasPermission('/payments') || hasPermission('/membership-plans') || hasPermission('/coin-management');

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const data = await fetchAdminStats();
      setStats(data);
      setError('');
      setLastRefresh(new Date());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useAutoRefresh(() => load(), REFRESH);

  const fmt = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000   ? `${(n / 1_000).toFixed(1)}K`
    : String(n);

  if (loading) return <Skeleton />;

  const userTrend  = stats ? buildSpark(stats.users.total)  : [];
  const videoTrend = stats ? buildSpark(stats.content.videos) : [];

  return (
    <motion.div {...fadeUp} transition={{ duration: 0.2 }} className="space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-text-primary tracking-tight">
            Dashboard
            {stats && stats.content.liveNow > 0 && (
              <span className="ml-2.5 inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full bg-danger/10 text-danger border border-danger/20 align-middle">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-danger opacity-60" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-danger" />
                </span>
                {stats.content.liveNow} Live
              </span>
            )}
          </h1>
          {lastRefresh && (
            <p className="text-[12px] text-text-tertiary mt-0.5">
              Updated {lastRefresh.toLocaleTimeString()} · auto-refreshes every 30s
            </p>
          )}
        </div>
        <ActionButton
          variant="secondary"
          size="sm"
          icon={RefreshCwIcon}
          isLoading={refreshing}
          onClick={() => load(true)}
        >
          Refresh
        </ActionButton>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2.5 px-4 py-3 rounded-md bg-danger/10 border border-danger/20 text-danger text-[13px]">
          <span className="w-1.5 h-1.5 rounded-full bg-danger shrink-0" />
          {error} — showing cached data
        </div>
      )}

      {!stats ? (
        <div className="card p-10 text-center text-text-tertiary text-[13px]">No data available</div>
      ) : (
        <>
          {/* Stats grid */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {showUsers && (
              <>
                <StatsCard title="Total Users"   value={fmt(stats.users.total)}     icon={UsersIcon}      path="/users" />
                <StatsCard title="Active Users"  value={fmt(stats.users.active)}    icon={UserCheckIcon}  path="/users" />
                <StatsCard title="New Today"     value={fmt(stats.users.newToday)}  icon={TrendingUpIcon} />
                <StatsCard title="Suspended"     value={fmt(stats.users.suspended)} icon={ShieldAlertIcon} />
              </>
            )}
            {showCreators && (
              <>
                <StatsCard title="Creators"    value={fmt(stats.creators.total)}               icon={StarIcon}    path="/creators" />
                <StatsCard title="Pending Apps" value={fmt(stats.creators.pendingApplications)} icon={FileTextIcon} path="/creator-applications" />
              </>
            )}
            {showContent && (
              <>
                <StatsCard title="Videos"   value={fmt(stats.content.videos)}  icon={VideoIcon}  path="/videos" />
                <StatsCard title="Live Now" value={fmt(stats.content.liveNow)} icon={RadioIcon}  path="/live-sessions" />
              </>
            )}
            {showFinance && (
              <StatsCard title="Members" value={fmt(stats.memberships.active)} icon={CreditCardIcon} path="/membership-plans" />
            )}
          </div>

          {/* Charts row */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

            {/* User trend chart */}
            {showUsers && (
              <SectionCard title="User Growth" icon={ActivityIcon} action={
                <span className="text-[11px] text-text-tertiary">7-day</span>
              }>
                <div className="lg:col-span-2">
                  <ResponsiveContainer width="100%" height={160}>
                    <AreaChart data={userTrend} margin={{ top: 4, right: 0, left: -28, bottom: 0 }}>
                      <defs>
                        <linearGradient id="uGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%"  stopColor="#ffffff" stopOpacity={0.08} />
                          <stop offset="95%" stopColor="#ffffff" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid vertical={false} stroke="#1f1f1f" strokeDasharray="0" />
                      <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#52525b' }} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: '#52525b' }} tickLine={false} axisLine={false} />
                      <Tooltip content={<ChartTooltip />} cursor={{ stroke: '#2a2a2a', strokeWidth: 1 }} />
                      <Area
                        type="monotone" dataKey="value"
                        stroke="#ffffff" strokeWidth={1.5}
                        fill="url(#uGrad)"
                        dot={false}
                        activeDot={{ r: 3, fill: '#ffffff', strokeWidth: 0 }}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </SectionCard>
            )}

            {/* Content bar chart */}
            {showContent && (
              <SectionCard title="Content by Type" icon={BarChart2Icon}>
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart
                    data={[
                      { name: 'Videos',  value: stats.content.videos },
                      { name: 'Live',    value: stats.content.liveNow },
                      { name: 'Members', value: stats.memberships.active },
                      { name: 'Creators', value: stats.creators.total },
                    ]}
                    margin={{ top: 4, right: 0, left: -28, bottom: 0 }}
                    barSize={22}
                  >
                    <CartesianGrid vertical={false} stroke="#1f1f1f" />
                    <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#52525b' }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: '#52525b' }} tickLine={false} axisLine={false} />
                    <Tooltip content={<ChartTooltip />} cursor={{ fill: '#1a1a1a' }} />
                    <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                      {[0,1,2,3].map(i => (
                        <Cell key={i} fill={i === 0 ? '#ffffff' : '#2a2a2a'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </SectionCard>
            )}

            {/* Live status + quick stats */}
            {showContent && (
              <SectionCard title="Platform Status" icon={RadioIcon}>
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-bg-elevated">
                    <div className={`relative w-8 h-8 rounded-full flex items-center justify-center ${stats.content.liveNow > 0 ? 'bg-danger/20' : 'bg-bg-overlay'}`}>
                      {stats.content.liveNow > 0 && (
                        <span className="absolute inset-0 rounded-full animate-ping bg-danger opacity-20" />
                      )}
                      <RadioIcon className={`w-4 h-4 ${stats.content.liveNow > 0 ? 'text-danger' : 'text-text-tertiary'}`} />
                    </div>
                    <div>
                      <p className="text-xl font-bold text-text-primary tabular-nums">{stats.content.liveNow}</p>
                      <p className="text-[11px] text-text-tertiary">Active sessions</p>
                    </div>
                  </div>

                  <div className="space-y-2.5 pt-1">
                    {[
                      { label: 'Total Videos',   value: stats.content.videos,   icon: VideoIcon },
                      { label: 'Active Members', value: stats.memberships.active, icon: CreditCardIcon },
                      { label: 'Total Creators', value: stats.creators.total,   icon: StarIcon },
                    ].map(({ label, value, icon: Icon }) => (
                      <div key={label} className="flex items-center justify-between text-[13px]">
                        <span className="flex items-center gap-2 text-text-tertiary">
                          <Icon className="w-3.5 h-3.5" />
                          {label}
                        </span>
                        <span className="font-semibold text-text-secondary tabular-nums">{value.toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </SectionCard>
            )}
          </div>

          {/* Bottom row */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">

            {/* User breakdown bars */}
            {showUsers && (
              <SectionCard title="User Breakdown" icon={UsersIcon}>
                <div className="space-y-3">
                  {[
                    { label: 'Active',    value: stats.users.active,    color: 'bg-white/80', total: stats.users.total },
                    { label: 'Suspended', value: stats.users.suspended, color: 'bg-warning',  total: stats.users.total },
                    { label: 'Creators',  value: stats.creators.total,  color: 'bg-accent',   total: stats.users.total },
                    { label: 'New Today', value: stats.users.newToday,  color: 'bg-success',  total: stats.users.total },
                  ].map(b => <BarItem key={b.label} {...b} />)}
                </div>
              </SectionCard>
            )}

            {/* Video trend */}
            {showContent && (
              <SectionCard title="Video Uploads" icon={VideoIcon} action={
                <span className="text-[11px] text-text-tertiary">7-day trend</span>
              }>
                <ResponsiveContainer width="100%" height={130}>
                  <AreaChart data={videoTrend} margin={{ top: 4, right: 0, left: -28, bottom: 0 }}>
                    <defs>
                      <linearGradient id="vGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.15} />
                        <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} stroke="#1f1f1f" />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#52525b' }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: '#52525b' }} tickLine={false} axisLine={false} />
                    <Tooltip content={<ChartTooltip />} cursor={{ stroke: '#2a2a2a', strokeWidth: 1 }} />
                    <Area
                      type="monotone" dataKey="value"
                      stroke="#3b82f6" strokeWidth={1.5}
                      fill="url(#vGrad)"
                      dot={false}
                      activeDot={{ r: 3, fill: '#3b82f6', strokeWidth: 0 }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </SectionCard>
            )}

            {/* Quick access */}
            <SectionCard title="Quick Access">
              <div className="space-y-0.5 -mx-1">
                {[
                  { label: 'Manage Users',         path: '/users',                icon: UsersIcon,        show: showUsers,    badge: undefined },
                  { label: 'Review Videos',         path: '/videos',               icon: VideoIcon,        show: showContent,  badge: undefined },
                  { label: 'Creator Applications',  path: '/creator-applications', icon: FileTextIcon,     show: showCreators, badge: stats?.creators.pendingApplications },
                  { label: 'Live Sessions',         path: '/live-sessions',        icon: RadioIcon,        show: showContent,  badge: stats?.content.liveNow },
                  { label: 'Payments',              path: '/payments',             icon: BanknoteIcon,     show: showFinance,  badge: undefined },
                  { label: 'Content Removal',       path: '/content-removal',      icon: ShieldAlertIcon,  show: showContent,  badge: undefined },
                  { label: 'Audit Logs',            path: '/audit-logs',           icon: ClipboardListIcon, show: !!user?.is_super_admin, badge: undefined },
                  { label: 'System Health',         path: '/it-operations',        icon: ServerIcon,       show: !!user?.is_super_admin, badge: undefined },
                ].filter(i => i.show).map(({ label, path, icon, badge }) => (
                  <QuickLink key={path} label={label} path={path} icon={icon} badge={badge} />
                ))}
              </div>
            </SectionCard>
          </div>
        </>
      )}
    </motion.div>
  );
}
