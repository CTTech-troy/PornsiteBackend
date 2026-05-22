import React, { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  BanIcon,
  CheckCircleIcon,
  EyeIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ShieldOffIcon,
  Trash2Icon,
  UserRoundIcon,
  XCircleIcon,
} from 'lucide-react';
import { FilterBar } from '../components/shared/FilterBar';
import { Pagination } from '../components/shared/Pagination';
import { StatusBadge, type StatusColor } from '../components/shared/StatusBadge';
import { ActionButton } from '../components/shared/ActionButton';
import { Modal } from '../components/shared/Modal';
import { DataTable, type Column } from '../components/shared/DataTable';
import {
  fetchCreatorMainApplications,
  approveCreatorMainApplication,
  rejectCreatorMainApplication,
  reconsiderCreatorMainApplication,
  banCreatorMainApplication,
  deleteCreatorMainApplication,
  removeCreatorAccessFromApplication,
  updateCreatorStatus,
  type CreatorMainApplication,
} from '../api/usersApi';
import { useToast } from '../contexts/ToastContext';

const statusColor: Record<string, StatusColor> = {
  pending: 'yellow',
  approved: 'green',
  rejected: 'red',
  banned: 'red',
  info_requested: 'blue',
};

const tabs = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'banned', label: 'Banned' },
];

type ActionType = 'approve' | 'reject' | 'reconsider' | 'ban' | 'delete' | 'suspend' | 'remove_access';

const actionCopy: Record<ActionType, { title: string; button: string; description: string; danger?: boolean; reasonRequired?: boolean }> = {
  approve: {
    title: 'Approve Application',
    button: 'Approve Creator',
    description: 'The applicant will become a creator, gain creator privileges, and appear in the creators list.',
  },
  reject: {
    title: 'Reject Application',
    button: 'Reject Application',
    description: 'The application will move to the rejected section and creator access will stay disabled.',
    danger: true,
    reasonRequired: true,
  },
  reconsider: {
    title: 'Reconsider Application',
    button: 'Move to Pending',
    description: 'The application will reopen for review while preserving the moderation history.',
  },
  ban: {
    title: 'Ban From Applying',
    button: 'Ban Applicant',
    description: 'The applicant will be blocked from submitting creator applications until the ban is removed or expires.',
    danger: true,
    reasonRequired: true,
  },
  delete: {
    title: 'Delete Application',
    button: 'Delete Application',
    description: 'Only rejected or banned applications can be deleted. Audit logs are kept.',
    danger: true,
    reasonRequired: true,
  },
  suspend: {
    title: 'Suspend Creator',
    button: 'Suspend Creator',
    description: 'The creator profile remains in the system, but the creator account is suspended.',
    danger: true,
  },
  remove_access: {
    title: 'Remove Creator Access',
    button: 'Remove Access',
    description: 'Creator privileges will be removed and the application will move to the rejected section.',
    danger: true,
    reasonRequired: true,
  },
};

function formatDate(value?: string | null, withTime = false) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString(undefined, withTime
    ? { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' });
}

function readableStatus(status: string) {
  return status.replace(/_/g, ' ');
}

export function CreatorApplications() {
  const navigate = useNavigate();
  const { success, error: toastError } = useToast();
  const [applications, setApplications] = useState<CreatorMainApplication[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('pending');
  const [actionLoading, setActionLoading] = useState(false);
  const [actionModal, setActionModal] = useState<{ open: boolean; app: CreatorMainApplication | null; action: ActionType | '' }>({ open: false, app: null, action: '' });
  const [reviewReason, setReviewReason] = useState('');
  const [banExpiresAt, setBanExpiresAt] = useState('');
  const [reasonError, setReasonError] = useState('');
  const limit = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetchCreatorMainApplications({ page, limit, search, status: statusFilter });
      setApplications(res.applications ?? []);
      setTotal(res.total ?? 0);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [page, search, statusFilter]);

  useEffect(() => { load(); }, [load]);

  const openAction = (app: CreatorMainApplication, action: ActionType) => {
    setReviewReason('');
    setBanExpiresAt('');
    setReasonError('');
    setActionModal({ open: true, app, action });
  };

  const closeAction = () => {
    if (actionLoading) return;
    setActionModal({ open: false, app: null, action: '' });
    setReviewReason('');
    setBanExpiresAt('');
    setReasonError('');
  };

  const removeFromCurrentTab = (appId: string) => {
    setApplications(prev => prev.filter(app => app.id !== appId));
    setTotal(prev => Math.max(0, prev - 1));
  };

  const submitAction = async () => {
    if (!actionModal.app || !actionModal.action) return;
    const meta = actionCopy[actionModal.action];
    const reason = reviewReason.trim();
    if (meta.reasonRequired && !reason) {
      setReasonError('Add a reason before continuing.');
      return;
    }

    try {
      setActionLoading(true);
      const app = actionModal.app;
      let message = '';
      if (actionModal.action === 'approve') {
        const res = await approveCreatorMainApplication(app.id, reason || undefined);
        message = res.message;
      } else if (actionModal.action === 'reject') {
        const res = await rejectCreatorMainApplication(app.id, reason);
        message = res.message;
      } else if (actionModal.action === 'reconsider') {
        const res = await reconsiderCreatorMainApplication(app.id, reason || undefined);
        message = res.message;
      } else if (actionModal.action === 'ban') {
        const res = await banCreatorMainApplication(app.id, reason, banExpiresAt || undefined);
        message = res.message;
      } else if (actionModal.action === 'delete') {
        const res = await deleteCreatorMainApplication(app.id, reason);
        message = res.message;
      } else if (actionModal.action === 'suspend') {
        const res = await updateCreatorStatus(app.creator_id || app.user_id, 'suspended', reason || 'Suspended from application moderation.');
        message = res.message;
      } else if (actionModal.action === 'remove_access') {
        const res = await removeCreatorAccessFromApplication(app.id, reason);
        message = res.message;
      }

      closeAction();
      removeFromCurrentTab(app.id);
      success(message || 'Application updated.');
      load();
    } catch (e: any) {
      toastError(e.message || 'Action failed.');
    } finally {
      setActionLoading(false);
    }
  };

  const renderActions = (app: CreatorMainApplication) => {
    const status = app.status || 'pending';
    if (status === 'pending' || status === 'info_requested') {
      return (
        <div className="flex items-center gap-1.5">
          <button onClick={() => navigate(`/creator-applications/${app.id}`)} className="p-1.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-secondary transition-colors" title="View">
            <EyeIcon className="w-4 h-4" />
          </button>
          <button onClick={() => openAction(app, 'approve')} className="p-1.5 rounded hover:bg-success/10 text-success transition-colors" title="Approve">
            <CheckCircleIcon className="w-4 h-4" />
          </button>
          <button onClick={() => openAction(app, 'reject')} className="p-1.5 rounded hover:bg-danger/10 text-danger transition-colors" title="Reject">
            <XCircleIcon className="w-4 h-4" />
          </button>
        </div>
      );
    }
    if (status === 'approved') {
      return (
        <div className="flex items-center gap-1.5">
          <button onClick={() => navigate(`/creator-applications/${app.id}`)} className="p-1.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-secondary transition-colors" title="View application">
            <EyeIcon className="w-4 h-4" />
          </button>
          <button onClick={() => navigate('/creators')} className="p-1.5 rounded hover:bg-accent/10 text-accent transition-colors" title="View creator">
            <UserRoundIcon className="w-4 h-4" />
          </button>
          <button onClick={() => openAction(app, 'suspend')} className="p-1.5 rounded hover:bg-warning/10 text-warning transition-colors" title="Suspend creator">
            <ShieldOffIcon className="w-4 h-4" />
          </button>
          <button onClick={() => openAction(app, 'remove_access')} className="p-1.5 rounded hover:bg-danger/10 text-danger transition-colors" title="Remove creator access">
            <XCircleIcon className="w-4 h-4" />
          </button>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-1.5">
        <button onClick={() => navigate(`/creator-applications/${app.id}`)} className="p-1.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-secondary transition-colors" title="View">
          <EyeIcon className="w-4 h-4" />
        </button>
        <button onClick={() => openAction(app, 'reconsider')} className="p-1.5 rounded hover:bg-accent/10 text-accent transition-colors" title="Reconsider">
          <RotateCcwIcon className="w-4 h-4" />
        </button>
        <button onClick={() => openAction(app, 'ban')} className="p-1.5 rounded hover:bg-danger/10 text-danger transition-colors" title="Ban from applying">
          <BanIcon className="w-4 h-4" />
        </button>
        <button onClick={() => openAction(app, 'delete')} className="p-1.5 rounded hover:bg-danger/10 text-danger transition-colors" title="Delete application">
          <Trash2Icon className="w-4 h-4" />
        </button>
      </div>
    );
  };

  const columns: Column<CreatorMainApplication>[] = [
    {
      key: 'applicant', header: 'Applicant',
      render: (a) => (
        <div className="flex items-center gap-3 min-w-[220px]">
          <img
            src={a.profile_picture || a.users?.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(a.full_name || a.users?.username || 'User')}&size=36&background=random`}
            className="w-9 h-9 rounded-full object-cover" alt=""
          />
          <div className="min-w-0">
            <p className="font-medium text-[13px] text-text-primary truncate">{a.full_name || a.users?.username || 'Applicant'}</p>
            <p className="text-[12px] text-text-tertiary truncate">{a.email || 'No email'}</p>
          </div>
        </div>
      ),
    },
    { key: 'username', header: 'Username', render: (a) => <span className="text-[13px] text-text-tertiary">@{a.users?.username || a.user_id}</span> },
    {
      key: 'category',
      header: 'Type',
      render: (a) => (
        <div className="space-y-1">
          <p className="text-[13px] text-text-secondary capitalize">{a.creator_type === 'channel' ? 'Channel' : 'Porn star'}</p>
          <p className="text-[11px] text-text-tertiary capitalize">{a.category || a.contentType || '-'}</p>
        </div>
      ),
    },
    {
      key: 'status', header: 'Status',
      render: (a) => <StatusBadge status={readableStatus(a.status)} color={statusColor[a.status] || 'gray'} />,
    },
    {
      key: 'review', header: 'Review',
      render: (a) => {
        const note = a.rejection_reason || a.review_reason || a.ban_reason || '';
        return (
          <div className="max-w-[260px] space-y-1">
            <p className="truncate text-[12px] text-text-secondary">{note || '-'}</p>
            {(a.reviewed_at || a.reviewed_by_name) && (
              <p className="text-[11px] text-text-tertiary">
                {a.reviewed_by_name || 'Admin'} · {formatDate(a.reviewed_at, true)}
              </p>
            )}
          </div>
        );
      },
    },
    {
      key: 'date', header: statusFilter === 'pending' ? 'Applied' : 'Updated',
      render: (a) => (
        <span className="text-[12px] text-text-tertiary">{formatDate(a.decision_at || a.reviewed_at || a.created_at)}</span>
      ),
    },
    { key: 'actions', header: 'Actions', render: renderActions },
  ];

  const activeAction = actionModal.action ? actionCopy[actionModal.action] : null;

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Creator Applications</h1>
          <p className="text-[13px] text-text-tertiary mt-0.5">{total.toLocaleString()} {statusFilter.replace('_', ' ')} applications</p>
        </div>
        <ActionButton icon={RefreshCwIcon} onClick={load} variant="secondary" isLoading={loading}>
          Refresh
        </ActionButton>
      </div>

      <div className="flex gap-2 overflow-x-auto custom-scrollbar">
        {tabs.map(tab => (
          <button
            key={tab.value}
            onClick={() => { setStatusFilter(tab.value); setPage(1); }}
            className={`h-9 rounded-md border px-3 text-[13px] font-medium transition-colors ${
              statusFilter === tab.value
                ? 'border-accent/40 bg-accent/10 text-accent'
                : 'border-border-default text-text-tertiary hover:border-border-strong hover:text-text-primary'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <FilterBar
        searchValue={search}
        onSearchChange={(v) => { setSearch(v); setPage(1); }}
        searchPlaceholder="Search by name, username or email..."
      />

      {error && <div className="bg-danger/10 border border-danger/20 rounded-lg p-4 text-danger text-[13px]">{error}</div>}

      <div className="card overflow-hidden">
        <DataTable columns={columns} data={applications} isLoading={loading} emptyMessage={`No ${statusFilter} applications found.`} />
        <Pagination
          currentPage={page}
          totalPages={Math.max(1, Math.ceil(total / limit))}
          totalItems={total}
          itemsPerPage={limit}
          onPageChange={setPage}
        />
      </div>

      <Modal isOpen={actionModal.open} onClose={closeAction} title={activeAction?.title || 'Review Application'} maxWidth="lg">
        <div className="space-y-5">
          <div className="rounded-xl border border-border-default bg-bg-elevated p-4">
            <p className="text-[13px] text-text-secondary">{activeAction?.description}</p>
            {actionModal.app && (
              <div className="mt-3 flex items-center gap-3">
                <img
                  src={actionModal.app.profile_picture || actionModal.app.users?.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(actionModal.app.full_name || actionModal.app.user_id)}&size=40&background=random`}
                  className="h-10 w-10 rounded-full object-cover"
                  alt=""
                />
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-semibold text-text-primary">{actionModal.app.full_name || actionModal.app.user_id}</p>
                  <p className="truncate text-[12px] text-text-tertiary">{actionModal.app.email || actionModal.app.user_id}</p>
                </div>
              </div>
            )}
          </div>

          <div>
            <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
              Reason / Note {activeAction?.reasonRequired && <span className="text-danger">*</span>}
            </label>
            <textarea
              value={reviewReason}
              onChange={(e) => { setReviewReason(e.target.value); if (reasonError && e.target.value.trim()) setReasonError(''); }}
              className={`input-field w-full min-h-[110px] resize-y ${reasonError ? 'border-danger ring-1 ring-danger' : ''}`}
              placeholder={activeAction?.reasonRequired ? 'Required: explain this moderation decision...' : 'Optional internal note...'}
              disabled={actionLoading}
            />
            {reasonError && <p className="text-danger text-[11px] mt-1">{reasonError}</p>}
          </div>

          {actionModal.action === 'ban' && (
            <div>
              <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Ban Expiration</label>
              <input
                type="date"
                value={banExpiresAt}
                onChange={(e) => setBanExpiresAt(e.target.value)}
                className="input-field w-full"
                disabled={actionLoading}
              />
              <p className="mt-1 text-[11px] text-text-tertiary">Leave empty for a permanent ban.</p>
            </div>
          )}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <ActionButton onClick={closeAction} variant="secondary" disabled={actionLoading} className="w-full sm:w-auto">Cancel</ActionButton>
            <ActionButton
              onClick={submitAction}
              isLoading={actionLoading}
              variant={activeAction?.danger ? 'danger' : 'primary'}
              className="w-full sm:w-auto"
            >
              {activeAction?.button || 'Submit'}
            </ActionButton>
          </div>
        </div>
      </Modal>
    </motion.div>
  );
}
