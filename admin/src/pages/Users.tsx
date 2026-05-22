import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  MoreHorizontalIcon, EyeIcon, BanIcon, ShieldAlertIcon,
  RefreshCwIcon, CreditCardIcon, CheckCircleIcon, Trash2Icon,
} from 'lucide-react';
import { DataTable, type Column } from '../components/shared/DataTable';
import { StatusBadge, type StatusColor } from '../components/shared/StatusBadge';
import { FilterBar } from '../components/shared/FilterBar';
import { Pagination } from '../components/shared/Pagination';
import { Modal } from '../components/shared/Modal';
import { ActionButton } from '../components/shared/ActionButton';
import { fetchUsers, updateUserStatus, updateUserCoins, deleteUser as deleteUserAccount, type User } from '../api/usersApi';
import { useToast } from '../contexts/ToastContext';
import { useAutoRefresh } from '../hooks/useAutoRefresh';

type SourceCounts = {
  mergedTotal: number;
  filteredTotal?: number;
  rawSourceTotal: number;
  supabaseTotal: number;
  firebaseAuthTotal: number;
  firestoreTotal: number;
  rtdbTotal: number;
  firebaseSourceTotal: number;
  firebaseOnlyTotal: number;
  supabaseOnlyTotal: number;
  sharedProviderTotal: number;
  deduplicatedTotal: number;
};

function ActionDropdown({ user, onAction }: { user: User; onAction: (action: string, user: User) => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setIsOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const menuItem = (label: string, action: string, icon: React.ReactNode, cls = '') => (
    <button
      key={action}
      onClick={() => { onAction(action, user); setIsOpen(false); }}
      className={`w-full text-left px-3 py-2 text-[13px] flex items-center gap-2 hover:bg-bg-elevated transition-colors ${cls}`}
    >
      {icon} {label}
    </button>
  );
  const status = user.status || 'active';

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setIsOpen(v => !v)}
        className="p-1.5 rounded-md hover:bg-bg-elevated text-text-tertiary hover:text-text-secondary transition-colors"
        aria-label="Actions"
      >
        <MoreHorizontalIcon className="w-4 h-4" />
      </button>
      {isOpen && (
        <div className="absolute right-0 mt-1 w-52 bg-bg-surface rounded-lg shadow-2xl border border-border-default z-50 py-1 overflow-hidden">
          {menuItem('View Details', 'view', <EyeIcon className="w-4 h-4" />, 'text-text-secondary')}
          {menuItem('Edit Coins', 'coins', <CreditCardIcon className="w-4 h-4" />, 'text-text-secondary')}
          {status !== 'active' && menuItem('Activate', 'activate', <CheckCircleIcon className="w-4 h-4" />, 'text-success')}
          {status !== 'suspended' && menuItem('Suspend', 'suspend', <ShieldAlertIcon className="w-4 h-4" />, 'text-warning')}
          {status !== 'banned' && menuItem('Ban User', 'ban', <BanIcon className="w-4 h-4" />, 'text-danger')}
          <div className="my-1 border-t border-border-default" />
          {menuItem('Delete User', 'delete', <Trash2Icon className="w-4 h-4" />, 'text-danger hover:bg-danger/10')}
        </div>
      )}
    </div>
  );
}

const ACTION_META: Record<string, { label: string; variant: 'primary' | 'danger' | 'warning'; description: string }> = {
  activate: { label: 'Activate', variant: 'primary', description: "This will restore the user's access to the platform." },
  suspend: { label: 'Suspend', variant: 'warning', description: 'This will temporarily block the user from accessing the platform.' },
  ban: { label: 'Ban', variant: 'danger', description: 'This will permanently block the user. This action is logged.' },
};

const statusColor: Record<string, StatusColor> = {
  active: 'green', suspended: 'yellow', banned: 'red',
};

function formatDate(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
}

export function Users() {
  const navigate = useNavigate();
  const { success, error: toastError } = useToast();

  const [users, setUsers] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [sourceCounts, setSourceCounts] = useState<SourceCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  const [coinsModal, setCoinsModal] = useState<{ open: boolean; user: User | null }>({ open: false, user: null });
  const [coinsValue, setCoinsValue] = useState('');
  const [coinsError, setCoinsError] = useState('');

  const [confirm, setConfirm] = useState<{ open: boolean; action: string; user: User | null }>({ open: false, action: '', user: null });
  const [deleteModal, setDeleteModal] = useState<{ open: boolean; user: User | null }>({ open: false, user: null });
  const [deleteReason, setDeleteReason] = useState('');
  const [deleteReasonError, setDeleteReasonError] = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetchUsers({ page, limit, search, statusFilter });
      setUsers(res.users ?? res.data ?? []);
      setTotal(res.total ?? 0);
      setSourceCounts(res.sourceCounts ?? null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [page, limit, search, statusFilter]);

  useEffect(() => { load(); }, [load]);
  useAutoRefresh(load, 60_000);

  const handleAction = (action: string, user: User) => {
    if (action === 'view') { navigate(`/users/${user.id}`); return; }
    if (action === 'coins') {
      setCoinsValue(String(user.coin_balance ?? 0));
      setCoinsError('');
      setCoinsModal({ open: true, user });
      return;
    }
    if (action === 'delete') {
      setDeleteReason('');
      setDeleteReasonError('');
      setDeleteModal({ open: true, user });
      return;
    }
    setConfirm({ open: true, action, user });
  };

  const executeStatusChange = async () => {
    if (!confirm.user) return;
    const statusMap: Record<string, string> = { activate: 'active', suspend: 'suspended', ban: 'banned' };
    const newStatus = statusMap[confirm.action];
    if (!newStatus) return;
    try {
      setActionLoading(true);
      await updateUserStatus(confirm.user.id, newStatus);
      success(`User ${newStatus} successfully.`);
      setConfirm({ open: false, action: '', user: null });
      load();
    } catch (e: any) {
      toastError(e.message);
    } finally {
      setActionLoading(false);
    }
  };

  const saveCoins = async () => {
    if (!coinsModal.user) return;
    const val = Number(coinsValue);
    if (!coinsValue.trim() || isNaN(val) || val < 0) {
      setCoinsError('Enter a valid non-negative number.');
      return;
    }
    if (val > 10_000_000) {
      setCoinsError('Cannot exceed 10,000,000 coins.');
      return;
    }
    try {
      setActionLoading(true);
      await updateUserCoins(coinsModal.user.id, Math.floor(val));
      success('Coin balance updated.');
      setCoinsModal({ open: false, user: null });
      load();
    } catch (e: any) {
      toastError(e.message);
    } finally {
      setActionLoading(false);
    }
  };

  const closeDeleteModal = () => {
    if (deleteLoading) return;
    setDeleteModal({ open: false, user: null });
    setDeleteReason('');
    setDeleteReasonError('');
  };

  const executeDeleteUser = async () => {
    if (!deleteModal.user) return;
    const reason = deleteReason.trim();
    if (!reason) {
      setDeleteReasonError('Add the admin reason before deleting this user.');
      return;
    }

    try {
      setDeleteLoading(true);
      const targetId = deleteModal.user.id;
      const res = await deleteUserAccount(targetId, reason);
      setUsers(prev => prev.filter(user => user.id !== targetId));
      setTotal(prev => Math.max(0, prev - 1));
      setDeleteModal({ open: false, user: null });
      setDeleteReason('');
      setDeleteReasonError('');
      success(res.message || 'User deleted successfully.');
      load();
    } catch (e: any) {
      toastError(e.message);
    } finally {
      setDeleteLoading(false);
    }
  };

  const columns: Column<User>[] = [
    {
      key: 'user', header: 'User',
      render: (u) => (
        <div className="flex items-center gap-3 min-w-0">
          <img
            src={u.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(u.display_name || u.username)}&size=36&background=1a1a1a&color=fff`}
            className="w-8 h-8 rounded-full object-cover flex-shrink-0"
            alt=""
          />
          <div className="min-w-0">
            <p className="font-medium text-text-primary text-[13px] truncate">{u.display_name || u.username}</p>
            <p className="text-[12px] text-text-tertiary truncate">@{u.username}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'email', header: 'Email',
      render: (u) => <span className="text-[13px] text-text-secondary">{u.email}</span>,
    },
    {
      key: 'status', header: 'Status',
      render: (u) => {
        const status = u.status || 'active';
        return <StatusBadge status={status} color={statusColor[status] || 'gray'} />;
      },
    },
    {
      key: 'active_plan', header: 'Plan',
      render: (u) => (
        <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${u.active_plan ? 'bg-accent/10 text-accent border border-accent/20' : 'text-text-tertiary'}`}>
          {u.active_plan || 'Free'}
        </span>
      ),
    },
    {
      key: 'coin_balance', header: 'Coins',
      render: (u) => <span className="text-[13px] font-mono tabular-nums text-text-primary">{(u.coin_balance ?? 0).toLocaleString()}</span>,
    },
    {
      key: 'is_creator', header: 'Creator',
      render: (u) => u.is_creator
        ? <span className="text-[12px] font-medium text-success">Yes</span>
        : <span className="text-[12px] text-text-tertiary">No</span>,
    },
    {
      key: 'created_at', header: 'Joined',
      render: (u) => <span className="text-[12px] text-text-tertiary">{formatDate(u.created_at)}</span>,
    },
    { key: 'actions', header: '', render: (u) => <ActionDropdown user={u} onAction={handleAction} /> },
  ];

  const confirmMeta = confirm.action ? ACTION_META[confirm.action] : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="space-y-5"
    >
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Users</h1>
          <p className="text-[13px] text-text-tertiary mt-0.5">
            {loading ? 'Loading…' : `${(total ?? 0).toLocaleString()} total users`}
          </p>
          {sourceCounts && (
            <div className="mt-3 flex flex-wrap gap-2">
              {[
                ['Merged', sourceCounts.mergedTotal],
                ['Supabase', sourceCounts.supabaseTotal],
                ['Firebase Auth', sourceCounts.firebaseAuthTotal],
                ['Firestore', sourceCounts.firestoreTotal],
                ['RTDB', sourceCounts.rtdbTotal],
                ['Firebase-only', sourceCounts.firebaseOnlyTotal],
              ].map(([label, value]) => (
                <span
                  key={label}
                  className="rounded-full border border-border-default bg-bg-surface px-2.5 py-1 text-[11px] font-medium text-text-tertiary"
                >
                  {label}: <span className="text-text-secondary">{Number(value).toLocaleString()}</span>
                </span>
              ))}
              {sourceCounts.deduplicatedTotal > 0 && (
                <span className="rounded-full border border-success/20 bg-success/10 px-2.5 py-1 text-[11px] font-medium text-success">
                  Deduped: {sourceCounts.deduplicatedTotal.toLocaleString()}
                </span>
              )}
            </div>
          )}
        </div>
        <ActionButton icon={RefreshCwIcon} onClick={load} variant="secondary" isLoading={loading}>
          Refresh
        </ActionButton>
      </div>

      <FilterBar
        searchValue={search}
        onSearchChange={v => { setSearch(v); setPage(1); }}
        searchPlaceholder="Search by name, username or email…"
        filters={[
          {
            label: 'Filter', value: statusFilter, onChange: v => { setStatusFilter(v); setPage(1); },
            options: [
              { value: '', label: 'All Users' },
              { value: 'active', label: 'Active' },
              { value: 'suspended', label: 'Suspended' },
              { value: 'banned', label: 'Banned' },
              { value: 'creator', label: 'Creators Only' },
            ],
          },
        ]}
      />

      {error && (
        <div className="bg-danger/10 border border-danger/20 rounded-lg p-4 text-danger text-[13px]">
          {error}
        </div>
      )}

      <div className="card overflow-hidden">
        <DataTable columns={columns} data={users} isLoading={loading} emptyMessage="No users found." />
        <Pagination
          currentPage={page}
          totalPages={Math.max(1, Math.ceil(total / limit))}
          totalItems={total}
          itemsPerPage={limit}
          onItemsPerPageChange={(nextLimit) => { setLimit(nextLimit); setPage(1); }}
          onPageChange={setPage}
        />
      </div>

      <Modal
        isOpen={confirm.open}
        onClose={() => setConfirm({ open: false, action: '', user: null })}
        title={`${confirmMeta?.label ?? ''} User`}
      >
        <div className="space-y-4">
          <p className="text-[13px] text-text-secondary">{confirmMeta?.description}</p>
          {confirm.user && (
            <div className="bg-bg-elevated rounded-lg p-3 flex items-center gap-3">
              <img
                src={confirm.user.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(confirm.user.display_name || confirm.user.username)}&size=36&background=1a1a1a&color=fff`}
                className="w-8 h-8 rounded-full object-cover"
                alt=""
              />
              <div>
                <p className="font-medium text-[13px] text-text-primary">{confirm.user.display_name || confirm.user.username}</p>
                <p className="text-[12px] text-text-tertiary">{confirm.user.email}</p>
              </div>
            </div>
          )}
          <div className="flex justify-end gap-3">
            <ActionButton onClick={() => setConfirm({ open: false, action: '', user: null })} variant="secondary">Cancel</ActionButton>
            <ActionButton onClick={executeStatusChange} isLoading={actionLoading} variant={confirmMeta?.variant ?? 'primary'}>
              {confirmMeta?.label}
            </ActionButton>
          </div>
        </div>
      </Modal>

      <Modal isOpen={coinsModal.open} onClose={() => setCoinsModal({ open: false, user: null })} title="Edit Coin Balance">
        <div className="space-y-4">
          <p className="text-[13px] text-text-secondary">
            Update coin balance for <strong className="text-text-primary">{coinsModal.user?.display_name || coinsModal.user?.username}</strong>
          </p>
          <div>
            <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Coin Balance</label>
            <input
              type="number"
              value={coinsValue}
              onChange={e => { setCoinsValue(e.target.value); setCoinsError(''); }}
              className="input-field w-full"
              min={0}
              max={10_000_000}
            />
            {coinsError && <p className="text-[11px] text-danger mt-1">{coinsError}</p>}
          </div>
          <div className="flex justify-end gap-3">
            <ActionButton onClick={() => setCoinsModal({ open: false, user: null })} variant="secondary">Cancel</ActionButton>
            <ActionButton onClick={saveCoins} isLoading={actionLoading} variant="primary">Save</ActionButton>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={deleteModal.open}
        onClose={closeDeleteModal}
        title="Delete User"
        maxWidth="lg"
      >
        <div className="space-y-5">
          <div className="rounded-xl border border-danger/25 bg-danger/10 p-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-danger/15 text-danger">
                <Trash2Icon className="h-4 w-4" />
              </div>
              <div>
                <p className="text-[14px] font-semibold text-text-primary">This permanently removes the user account.</p>
                <p className="mt-1 text-[12px] leading-5 text-text-secondary">
                  The backend will clean linked profile data, creator records, sessions, auth records, and media references where supported. This action is audited and cannot be undone from this panel.
                </p>
              </div>
            </div>
          </div>

          {deleteModal.user && (
            <div className="rounded-xl border border-border-default bg-bg-elevated p-4">
              <div className="flex items-center gap-3">
                <img
                  src={deleteModal.user.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(deleteModal.user.display_name || deleteModal.user.username)}&size=48&background=1a1a1a&color=fff`}
                  className="h-11 w-11 rounded-full object-cover"
                  alt=""
                />
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-semibold text-text-primary">
                    {deleteModal.user.display_name || deleteModal.user.username || 'Unnamed user'}
                  </p>
                  <p className="truncate text-[12px] text-text-tertiary">{deleteModal.user.email || 'No email on file'}</p>
                </div>
              </div>

              <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                <div>
                  <dt className="text-[11px] font-medium uppercase tracking-wide text-text-tertiary">User Name</dt>
                  <dd className="mt-1 truncate text-[13px] text-text-primary">{deleteModal.user.display_name || deleteModal.user.username || 'Unnamed user'}</dd>
                </div>
                <div>
                  <dt className="text-[11px] font-medium uppercase tracking-wide text-text-tertiary">User Email</dt>
                  <dd className="mt-1 truncate text-[13px] text-text-primary">{deleteModal.user.email || 'No email on file'}</dd>
                </div>
              </dl>
            </div>
          )}

          <div>
            <label htmlFor="delete-reason" className="block text-[12px] font-medium text-text-secondary mb-1.5">
              Admin Reason <span className="text-danger">*</span>
            </label>
            <textarea
              id="delete-reason"
              value={deleteReason}
              onChange={e => {
                setDeleteReason(e.target.value);
                if (deleteReasonError) setDeleteReasonError('');
              }}
              className="input-field min-h-[120px] w-full resize-y leading-5"
              maxLength={2000}
              placeholder="Explain why this account is being deleted. This reason will be included in the email sent to the user."
              disabled={deleteLoading}
              autoFocus
            />
            <div className="mt-1.5 flex items-center justify-between gap-3">
              {deleteReasonError ? (
                <p className="text-[11px] text-danger">{deleteReasonError}</p>
              ) : (
                <p className="text-[11px] text-text-tertiary">Required for the audit log and deletion email.</p>
              )}
              <span className="shrink-0 text-[11px] text-text-tertiary">{deleteReason.length}/2000</span>
            </div>
          </div>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <ActionButton
              onClick={closeDeleteModal}
              variant="secondary"
              className="w-full sm:w-auto"
              disabled={deleteLoading}
            >
              Cancel
            </ActionButton>
            <ActionButton
              onClick={executeDeleteUser}
              isLoading={deleteLoading}
              variant="danger"
              icon={Trash2Icon}
              className="w-full sm:w-auto"
            >
              Delete User
            </ActionButton>
          </div>
        </div>
      </Modal>
    </motion.div>
  );
}
