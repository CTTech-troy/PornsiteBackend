import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { DownloadIcon, RefreshCwIcon, SearchIcon, WifiIcon } from 'lucide-react';
import { DataTable, type Column } from '../components/shared/DataTable';
import { Pagination } from '../components/shared/Pagination';
import { ActionButton } from '../components/shared/ActionButton';
import { fetchAuditLogs, subscribeAuditLogEvents, type AuditLog } from '../api/moderationApi';

const ACTION_TYPES = [
  ['', 'All actions'],
  ['auth_login', 'Login'],
  ['auth_logout', 'Logout'],
  ['admin_team', 'Admin team'],
  ['settings', 'Settings'],
  ['finance', 'Finance'],
  ['content_removal', 'Content removal'],
  ['creator_moderation', 'Creator moderation'],
  ['user_moderation', 'User moderation'],
  ['content_moderation', 'Content moderation'],
  ['api_failure', 'API failures'],
];

const SEVERITIES = [
  ['', 'All severities'],
  ['info', 'Info'],
  ['warning', 'Warning'],
  ['error', 'Error'],
  ['critical', 'Critical'],
];

function fmt(value?: string | null) {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function pillClass(value?: string) {
  if (value === 'critical') return 'bg-danger/10 text-danger border-danger/20';
  if (value === 'error') return 'bg-danger/10 text-danger border-danger/20';
  if (value === 'warning') return 'bg-warning/10 text-warning border-warning/20';
  if (value === 'success') return 'bg-success/10 text-success border-success/20';
  return 'bg-bg-elevated text-text-secondary border-border-default';
}

function detailPreview(details: Record<string, unknown> = {}) {
  return Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    .join(' | ') || '-';
}

export function AuditLogs() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [live, setLive] = useState(false);
  const [search, setSearch] = useState('');
  const [adminFilter, setAdminFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [severityFilter, setSeverityFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const limit = 25;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetchAuditLogs({
        page,
        limit,
        search,
        adminFilter,
        actionFilter,
        severityFilter,
        statusFilter,
        fromDate,
        toDate,
      });
      setLogs(res.logs || []);
      setTotal(res.total || 0);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [page, search, adminFilter, actionFilter, severityFilter, statusFilter, fromDate, toDate]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    return subscribeAuditLogEvents(
      (next) => {
        setLogs((prev) => [next, ...prev.filter((item) => item.id !== next.id)].slice(0, limit));
        setTotal((value) => value + 1);
      },
      setLive,
    );
  }, [load]);

  const resetFilters = () => {
    setPage(1);
    setSearch('');
    setAdminFilter('');
    setActionFilter('');
    setSeverityFilter('');
    setStatusFilter('');
    setFromDate('');
    setToDate('');
  };

  const exportCSV = () => {
    const header = ['Admin', 'Email', 'Action', 'Type', 'Resource', 'Status', 'Severity', 'IP', 'Device', 'Date'];
    const rows = logs.map((l) => [
      l.admin_name,
      l.admin_email || '',
      l.action,
      l.action_type || '',
      `${l.target_type}:${l.target_id || ''}`,
      l.status,
      l.severity || 'info',
      l.ip_address || '',
      l.device || '',
      fmt(l.created_at),
    ]);
    const csv = [header, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-logs-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const columns: Column<AuditLog>[] = useMemo(() => [
    {
      key: 'admin',
      header: 'Admin',
      render: (log) => (
        <div className="min-w-[170px]">
          <p className="text-[13px] font-medium text-text-primary">{log.admin_name || 'Admin'}</p>
          <p className="text-[11px] text-text-tertiary truncate">{log.admin_email || '-'}</p>
        </div>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      render: (log) => (
        <div className="min-w-[180px]">
          <p className="text-[13px] font-medium text-text-primary">{log.action}</p>
          <p className="text-[11px] text-text-tertiary">{log.action_type || 'admin_action'}</p>
        </div>
      ),
    },
    {
      key: 'resource',
      header: 'Resource',
      render: (log) => (
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-border-default bg-bg-elevated px-2 py-0.5 text-[11px] font-medium text-text-secondary">
            {log.target_type}
          </span>
          <span className="max-w-[120px] truncate font-mono text-[11px] text-text-tertiary">{log.target_id || '-'}</span>
        </div>
      ),
    },
    {
      key: 'security',
      header: 'Security',
      render: (log) => (
        <div className="space-y-1 text-[11px] text-text-tertiary">
          <div>{log.ip_address || '-'}</div>
          <div className="max-w-[180px] truncate">{log.device || log.user_agent || '-'}</div>
        </div>
      ),
    },
    {
      key: 'state',
      header: 'State',
      render: (log) => (
        <div className="flex flex-wrap gap-1.5">
          <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${pillClass(log.status)}`}>
            {log.status}
          </span>
          <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${pillClass(log.severity)}`}>
            {log.severity || 'info'}
          </span>
        </div>
      ),
    },
    {
      key: 'details',
      header: 'Details',
      render: (log) => <span className="line-clamp-2 text-[12px] text-text-tertiary">{detailPreview(log.details)}</span>,
    },
    {
      key: 'created_at',
      header: 'Date',
      render: (log) => <span className="whitespace-nowrap text-[12px] text-text-tertiary">{fmt(log.created_at)}</span>,
    },
  ], []);

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold text-text-primary">Audit Logs</h1>
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${live ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}`}>
              <WifiIcon className="h-3 w-3" />
              {live ? 'Live' : 'Polling'}
            </span>
          </div>
          <p className="mt-0.5 text-[13px] text-text-tertiary">{total.toLocaleString()} total entries</p>
        </div>
        <div className="flex items-center gap-2">
          <ActionButton icon={DownloadIcon} onClick={exportCSV} variant="secondary">Export CSV</ActionButton>
          <ActionButton icon={RefreshCwIcon} onClick={load} variant="secondary" isLoading={loading}>Refresh</ActionButton>
        </div>
      </div>

      <div className="card p-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-7">
          <label className="relative xl:col-span-2">
            <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary" />
            <input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              placeholder="Search activity history"
              className="input-field pl-9"
            />
          </label>
          <input value={adminFilter} onChange={(e) => { setAdminFilter(e.target.value); setPage(1); }} placeholder="Admin name/email" className="input-field" />
          <select value={actionFilter} onChange={(e) => { setActionFilter(e.target.value); setPage(1); }} className="input-field">
            {ACTION_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select value={severityFilter} onChange={(e) => { setSeverityFilter(e.target.value); setPage(1); }} className="input-field">
            {SEVERITIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} className="input-field">
            <option value="">All states</option>
            <option value="success">Success</option>
            <option value="failure">Failure</option>
          </select>
          <button type="button" onClick={resetFilters} className="rounded-lg border border-border-default px-3 text-[13px] font-medium text-text-secondary hover:bg-bg-elevated">
            Reset
          </button>
          <input value={fromDate} onChange={(e) => { setFromDate(e.target.value); setPage(1); }} type="date" className="input-field" />
          <input value={toDate} onChange={(e) => { setToDate(e.target.value); setPage(1); }} type="date" className="input-field" />
        </div>
      </div>

      {error && <div className="rounded-lg border border-danger/20 bg-danger/10 p-4 text-[13px] text-danger">{error}</div>}

      <div className="card overflow-hidden">
        <DataTable columns={columns} data={logs} isLoading={loading} emptyMessage="No audit logs found." />
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
