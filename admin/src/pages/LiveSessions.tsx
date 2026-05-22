import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { RefreshCwIcon, BanIcon, CheckCircleIcon } from 'lucide-react';
import { DataTable, type Column } from '../components/shared/DataTable';
import { StatusBadge, type StatusColor } from '../components/shared/StatusBadge';
import { FilterBar } from '../components/shared/FilterBar';
import { Pagination } from '../components/shared/Pagination';
import { ActionButton } from '../components/shared/ActionButton';
import { fetchLiveSessions, updateLiveStatus, type LiveSession } from '../api/contentApi';

const statusColor: Record<string, StatusColor> = {
  live: 'green', paused: 'yellow', ended: 'gray', banned: 'red',
};

export function LiveSessions() {
  const navigate = useNavigate();
  const [lives, setLives] = useState<LiveSession[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const limit = 20;

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await fetchLiveSessions({ page, limit, search, statusFilter });
      setLives(res.lives);
      setTotal(res.total);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [page, search, statusFilter]);

  useEffect(() => { load(); }, [load]);

  const handleStatus = async (id: string, status: string) => {
    try {
      setActionLoading(true);
      await updateLiveStatus(id, status);
      load();
    } catch (e: any) { console.error(e.message); }
    finally { setActionLoading(false); }
  };

  const columns: Column<LiveSession>[] = [
    {
      key: 'host', header: 'Host',
      render: (l) => (
        <div className="flex items-center gap-3">
          <img src={l.hostAvatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(l.hostName)}&size=36`}
            className="w-9 h-9 rounded-full object-cover" alt="" />
          <div>
            <p className="font-medium text-[13px] text-text-primary">{l.hostName}</p>
            <p className="text-[12px] text-text-tertiary">{l.title || 'Live Stream'}</p>
          </div>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (l) => <StatusBadge status={l.status} color={statusColor[l.status] || 'gray'} /> },
    { key: 'viewers_count', header: 'Viewers', render: (l) => <span className="text-[13px] text-text-primary tabular-nums">{l.viewers_count.toLocaleString()}</span> },
    { key: 'total_likes', header: 'Likes', render: (l) => <span className="text-[13px] text-text-primary tabular-nums">{l.total_likes.toLocaleString()}</span> },
    { key: 'total_gifts', header: 'Gifts (₦)', render: (l) => <span className="text-[13px] text-text-primary tabular-nums">₦{l.total_gifts_amount.toLocaleString()}</span> },
    {
      key: 'started', header: 'Started',
      render: (l) => <span className="text-[12px] text-text-tertiary">{new Date(l.created_at).toLocaleString()}</span>,
    },
    {
      key: 'actions', header: 'Actions',
      render: (l) => (
        <div className="flex items-center gap-1">
          <button onClick={() => navigate(`/live-sessions/${l.id}`)} className="px-2 py-1 rounded text-[12px] font-medium text-accent hover:text-accent-hover transition-colors">View</button>
          {l.status === 'live' && (
            <button onClick={() => handleStatus(l.id, 'ended')} className="p-1.5 rounded hover:bg-danger/10 text-danger transition-colors" title="Force End">
              <BanIcon className="w-4 h-4" />
            </button>
          )}
          {l.status === 'banned' && (
            <button onClick={() => handleStatus(l.id, 'ended')} className="p-1.5 rounded hover:bg-success/10 text-success transition-colors" title="Unban">
              <CheckCircleIcon className="w-4 h-4" />
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Live Sessions</h1>
          <p className="text-[13px] text-text-tertiary mt-0.5">{total.toLocaleString()} total sessions</p>
        </div>
        <ActionButton icon={RefreshCwIcon} onClick={load} variant="secondary" isLoading={loading}>
          Refresh
        </ActionButton>
      </div>

      <FilterBar
        searchValue={search}
        onSearchChange={(v) => { setSearch(v); setPage(1); }}
        searchPlaceholder="Search by host name or title…"
        filters={[{
          label: 'Status', value: statusFilter, onChange: (v) => { setStatusFilter(v); setPage(1); },
          options: [
            { value: '', label: 'All' }, { value: 'live', label: 'Live' },
            { value: 'paused', label: 'Paused' }, { value: 'ended', label: 'Ended' },
            { value: 'banned', label: 'Banned' },
          ],
        }]}
      />

      {error && <div className="bg-danger/10 border border-danger/20 rounded-lg p-4 text-danger text-[13px]">{error}</div>}

      <div className="card overflow-hidden">
        <DataTable columns={columns} data={lives} isLoading={loading} emptyMessage="No live sessions found." />
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
