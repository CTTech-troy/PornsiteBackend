import React, { useEffect, useState, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  MoreHorizontalIcon, BanIcon, ShieldAlertIcon, CheckCircleIcon, RefreshCwIcon,
} from 'lucide-react';
import { DataTable, type Column } from '../components/shared/DataTable';
import { StatusBadge, type StatusColor } from '../components/shared/StatusBadge';
import { FilterBar } from '../components/shared/FilterBar';
import { Pagination } from '../components/shared/Pagination';
import { ActionButton } from '../components/shared/ActionButton';
import { fetchCreators, updateCreatorStatus, type Creator } from '../api/usersApi';
import { useToast } from '../contexts/ToastContext';

function ActionDropdown({ creator, onAction }: { creator: Creator; onAction: (action: string, c: Creator) => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setIsOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const btn = (label: string, action: string, icon: React.ReactNode, cls = '') => (
    <button key={action} onClick={() => { onAction(action, creator); setIsOpen(false); }}
      className={`w-full text-left px-3 py-2 text-[13px] flex items-center gap-2 hover:bg-bg-elevated transition-colors ${cls}`}>
      {icon} {label}
    </button>
  );

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setIsOpen(!isOpen)}
        className="p-1.5 rounded-md hover:bg-bg-elevated text-text-tertiary hover:text-text-secondary transition-colors">
        <MoreHorizontalIcon className="w-4 h-4" />
      </button>
      {isOpen && (
        <div className="absolute right-0 mt-1 w-48 bg-bg-surface rounded-lg shadow-2xl border border-border-default z-50 py-1 overflow-hidden">
          {creator.status !== 'active' && btn('Activate', 'activate', <CheckCircleIcon className="w-4 h-4" />, 'text-success')}
          {creator.status !== 'suspended' && btn('Suspend', 'suspend', <ShieldAlertIcon className="w-4 h-4" />, 'text-warning')}
          {creator.status !== 'banned' && btn('Ban', 'ban', <BanIcon className="w-4 h-4" />, 'text-danger')}
        </div>
      )}
    </div>
  );
}

const statusColor: Record<string, StatusColor> = { active: 'green', suspended: 'yellow', banned: 'red' };

export function Creators() {
  const [creators, setCreators] = useState<Creator[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const { success, error: toastError } = useToast();
  const limit = 20;

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await fetchCreators({ page, limit, search, statusFilter });
      setCreators(res.creators ?? []);
      setTotal(res.total ?? 0);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [page, search, statusFilter]);

  useEffect(() => { load(); }, [load]);

  const handleAction = async (action: string, creator: Creator) => {
    const statusMap: Record<string, string> = { activate: 'active', suspend: 'suspended', ban: 'banned' };
    const newStatus = statusMap[action];
    if (!newStatus) return;
    try {
      setActionLoading(true);
      await updateCreatorStatus(creator.id, newStatus);
      success(`Creator ${newStatus} successfully.`);
      load();
    } catch (e: any) { toastError(e.message); }
    finally { setActionLoading(false); }
  };

  const columns: Column<Creator>[] = [
    {
      key: 'creator', header: 'Creator',
      render: (c) => (
        <div className="flex items-center gap-3">
          <img
            src={c.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(c.display_name || c.username)}&size=36&background=1a1a1a&color=fff`}
            className="w-8 h-8 rounded-full object-cover flex-shrink-0"
            alt=""
          />
          <div>
            <p className="font-medium text-[13px] text-text-primary">{c.display_name || c.username}</p>
            <p className="text-[12px] text-text-tertiary">{String(c.channel_name || `@${c.username}`)}</p>
          </div>
        </div>
      ),
    },
    { key: 'email', header: 'Email', render: (c) => <span className="text-[13px] text-text-secondary">{c.email || '—'}</span> },
    { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.status || 'active'} color={statusColor[c.status] || 'green'} /> },
    {
      key: 'is_verified', header: 'Verified',
      render: (c) => c.is_verified
        ? <span className="text-[12px] text-accent font-medium">✓ Verified</span>
        : <span className="text-[12px] text-text-tertiary">—</span>,
    },
    { key: 'followers', header: 'Followers', render: (c) => <span className="text-[13px] text-text-primary tabular-nums">{(c.followers || 0).toLocaleString()}</span> },
    { key: 'created_at', header: 'Joined', render: (c) => <span className="text-[12px] text-text-tertiary">{c.created_at ? new Date(c.created_at).toLocaleDateString() : '—'}</span> },
    { key: 'actions', header: '', render: (c) => <ActionDropdown creator={c} onAction={handleAction} /> },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="space-y-5"
    >
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Creators</h1>
          <p className="text-[13px] text-text-tertiary mt-0.5">{total.toLocaleString()} total creators</p>
        </div>
        <ActionButton icon={RefreshCwIcon} onClick={load} variant="secondary" isLoading={loading}>
          Refresh
        </ActionButton>
      </div>

      <FilterBar
        searchValue={search}
        onSearchChange={(v) => { setSearch(v); setPage(1); }}
        searchPlaceholder="Search by name, channel or email…"
        filters={[{
          label: 'Status', value: statusFilter, onChange: (v) => { setStatusFilter(v); setPage(1); },
          options: [
            { value: '', label: 'All Statuses' },
            { value: 'active', label: 'Active' },
            { value: 'suspended', label: 'Suspended' },
            { value: 'banned', label: 'Banned' },
          ],
        }]}
      />

      {error && (
        <div className="bg-danger/10 border border-danger/20 rounded-lg p-4 text-danger text-[13px]">{error}</div>
      )}

      <div className="card overflow-hidden">
        <DataTable columns={columns} data={creators} isLoading={loading} emptyMessage="No creators found." />
        <Pagination
          currentPage={page}
          totalPages={Math.max(1, Math.ceil(total / limit))}
          totalItems={total}
          itemsPerPage={limit}
          onPageChange={setPage}
        />
      </div>
    </motion.div>
  );
}
