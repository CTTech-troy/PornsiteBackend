import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { RefreshCwIcon } from 'lucide-react';
import { DataTable, type Column } from '../components/shared/DataTable';
import { StatusBadge, type StatusColor } from '../components/shared/StatusBadge';
import { FilterBar } from '../components/shared/FilterBar';
import { Pagination } from '../components/shared/Pagination';
import { ActionButton } from '../components/shared/ActionButton';
import { fetchRandomSessions, type RandomSession } from '../api/contentApi';

const statusColor: Record<string, StatusColor> = {
  active: 'green', ended: 'gray', reported: 'red',
};

export function RandomSessions() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<RandomSession[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const limit = 20;

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await fetchRandomSessions({ page, limit, search, statusFilter });
      setSessions(res.sessions);
      setTotal(res.total);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [page, search, statusFilter]);

  useEffect(() => { load(); }, [load]);

  const columns: Column<RandomSession>[] = [
    { key: 'id', header: 'Session ID', render: (s) => <span className="text-sm font-mono text-gray-500">{String(s.id).slice(0, 12)}…</span> },
    { key: 'status', header: 'Status', render: (s) => <StatusBadge status={s.status} color={statusColor[s.status] || 'gray'} /> },
    {
      key: 'participants', header: 'Participants',
      render: (s) => (
        <span className="text-sm text-gray-600 dark:text-gray-400">
          {[s.user1_id, s.user2_id].filter(Boolean).length} users
        </span>
      ),
    },
    {
      key: 'created_at', header: 'Started',
      render: (s) => <span className="text-sm text-gray-500">{new Date(s.created_at).toLocaleString()}</span>,
    },
    {
      key: 'ended_at', header: 'Ended',
      render: (s) => <span className="text-sm text-gray-500">{s.ended_at ? new Date(String(s.ended_at)).toLocaleString() : 'Ongoing'}</span>,
    },
    {
      key: 'actions', header: '',
      render: (s) => (
        <button onClick={() => navigate(`/random-sessions/${s.id}`)} className="text-xs text-brand-primary hover:underline">View</button>
      ),
    },
  ];

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Random Sessions</h1>
          <p className="text-sm text-gray-500 mt-1">{total.toLocaleString()} total sessions</p>
        </div>
        <ActionButton label="Refresh" icon={<RefreshCwIcon className="w-4 h-4" />} onClick={load} variant="secondary" />
      </div>

      <FilterBar
        searchValue={search}
        onSearchChange={(v) => { setSearch(v); setPage(1); }}
        searchPlaceholder="Search sessions…"
        filters={[{
          label: 'Status', value: statusFilter, onChange: (v) => { setStatusFilter(v); setPage(1); },
          options: [{ value: '', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'ended', label: 'Ended' }, { value: 'reported', label: 'Reported' }],
        }]}
      />

      {error && <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 rounded-lg p-4 text-red-700 dark:text-red-400 text-sm">{error}</div>}
      <DataTable columns={columns} data={sessions} isLoading={loading} emptyMessage="No random sessions found." />
      <Pagination currentPage={page} totalPages={Math.ceil(total / limit)} onPageChange={setPage} />
    </motion.div>
  );
}
