import React, { useEffect, useState, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  MoreHorizontalIcon, EyeIcon, CheckCircleIcon, BanIcon,
  EyeOffIcon, TrashIcon, RefreshCwIcon,
} from 'lucide-react';
import { DataTable, type Column } from '../components/shared/DataTable';
import { StatusBadge, type StatusColor } from '../components/shared/StatusBadge';
import { FilterBar } from '../components/shared/FilterBar';
import { Pagination } from '../components/shared/Pagination';
import { Modal } from '../components/shared/Modal';
import { ActionButton } from '../components/shared/ActionButton';
import { fetchVideos, updateVideoStatus, deleteVideo, type Video } from '../api/contentApi';
import { useToast } from '../contexts/ToastContext';
import { useAutoRefresh } from '../hooks/useAutoRefresh';

function ActionDropdown({ video, onAction }: { video: Video; onAction: (action: string, v: Video) => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setIsOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const btn = (label: string, action: string, icon: React.ReactNode, cls = '') => (
    <button key={action} onClick={() => { onAction(action, video); setIsOpen(false); }}
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
        <div className="absolute right-0 mt-1 w-52 bg-bg-surface rounded-lg shadow-2xl border border-border-default z-50 py-1 overflow-hidden">
          {video.videoUrl && btn('View Video', 'view', <EyeIcon className="w-4 h-4" />, 'text-text-secondary')}
          {video.status !== 'published' && btn('Approve / Publish', 'publish', <CheckCircleIcon className="w-4 h-4" />, 'text-success')}
          {video.status !== 'blocked' && btn('Block', 'block', <BanIcon className="w-4 h-4" />, 'text-warning')}
          {video.status !== 'removed' && btn('Remove', 'remove', <EyeOffIcon className="w-4 h-4" />, 'text-warning')}
          {btn('Delete', 'delete', <TrashIcon className="w-4 h-4" />, 'text-danger')}
        </div>
      )}
    </div>
  );
}

const statusColor: Record<string, StatusColor> = {
  published: 'green', pending: 'yellow', blocked: 'red', removed: 'gray',
};

export function Videos() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [deleteModal, setDeleteModal] = useState<{ open: boolean; video: Video | null }>({ open: false, video: null });
  const { success, error: toastError } = useToast();
  const limit = 20;

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await fetchVideos({ page, limit, search, statusFilter });
      setVideos(res.videos ?? []);
      setTotal(res.total ?? 0);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [page, search, statusFilter]);

  useEffect(() => { load(); }, [load]);
  useAutoRefresh(load, 60_000);

  const handleAction = async (action: string, video: Video) => {
    if (action === 'view') { window.open(video.videoUrl!, '_blank'); return; }
    if (action === 'delete') { setDeleteModal({ open: true, video }); return; }
    const statusMap: Record<string, string> = { publish: 'published', block: 'blocked', remove: 'removed' };
    const newStatus = statusMap[action];
    if (!newStatus) return;
    try {
      setActionLoading(true);
      await updateVideoStatus(video.id, newStatus);
      success(`Video ${newStatus} successfully.`);
      load();
    } catch (e: any) { toastError(e.message); }
    finally { setActionLoading(false); }
  };

  const confirmDelete = async () => {
    if (!deleteModal.video) return;
    try {
      setActionLoading(true);
      await deleteVideo(deleteModal.video.id);
      success('Video deleted.');
      setDeleteModal({ open: false, video: null });
      load();
    } catch (e: any) { toastError(e.message); }
    finally { setActionLoading(false); }
  };

  const columns: Column<Video>[] = [
    {
      key: 'video', header: 'Video',
      render: (v) => (
        <div className="flex items-center gap-3">
          {v.thumbnail
            ? <img src={v.thumbnail} className="w-16 h-10 rounded object-cover flex-shrink-0" alt="" />
            : <div className="w-16 h-10 rounded bg-bg-elevated flex-shrink-0" />}
          <div className="min-w-0">
            <p className="font-medium text-[13px] text-text-primary truncate max-w-[200px]">{v.title}</p>
            <p className="text-[12px] text-text-tertiary">{v.creatorName}</p>
          </div>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (v) => <StatusBadge status={v.status} color={statusColor[v.status] || 'gray'} /> },
    { key: 'visibility', header: 'Visibility', render: (v) => <span className="text-[12px] capitalize text-text-secondary">{v.visibility}</span> },
    { key: 'views', header: 'Views', render: (v) => <span className="text-[13px] text-text-primary tabular-nums">{v.views.toLocaleString()}</span> },
    { key: 'likes', header: 'Likes', render: (v) => <span className="text-[13px] text-text-primary tabular-nums">{v.likes.toLocaleString()}</span> },
    {
      key: 'uploadDate', header: 'Uploaded',
      render: (v) => <span className="text-[12px] text-text-tertiary">{v.uploadDate ? new Date(v.uploadDate).toLocaleDateString() : '—'}</span>,
    },
    { key: 'actions', header: '', render: (v) => <ActionDropdown video={v} onAction={handleAction} /> },
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
          <h1 className="text-xl font-semibold text-text-primary">Videos</h1>
        </div>
        <ActionButton icon={RefreshCwIcon} onClick={load} variant="secondary" isLoading={loading}>
          Refresh
        </ActionButton>
      </div>

      <FilterBar
        searchValue={search}
        onSearchChange={(v) => { setSearch(v); setPage(1); }}
        searchPlaceholder="Search by title or creator…"
        filters={[{
          label: 'Status', value: statusFilter, onChange: (v) => { setStatusFilter(v); setPage(1); },
          options: [
            { value: '', label: 'All Statuses' }, { value: 'published', label: 'Published' },
            { value: 'pending', label: 'Pending' }, { value: 'blocked', label: 'Blocked' },
            { value: 'removed', label: 'Removed' },
          ],
        }]}
      />

      {error && (
        <div className="bg-danger/10 border border-danger/20 rounded-lg p-4 text-danger text-[13px]">{error}</div>
      )}

      <div className="card overflow-hidden">
        <DataTable columns={columns} data={videos} isLoading={loading} emptyMessage="No videos found." />
        <Pagination
          currentPage={page}
          totalPages={Math.max(1, Math.ceil(total / limit))}
          totalItems={total}
          itemsPerPage={limit}
          onPageChange={setPage}
        />
      </div>

      <Modal isOpen={deleteModal.open} onClose={() => setDeleteModal({ open: false, video: null })} title="Delete Video">
        <div className="space-y-4">
          <p className="text-[13px] text-text-secondary">
            Permanently delete <strong className="text-text-primary">"{deleteModal.video?.title}"</strong>? This cannot be undone.
          </p>
          <div className="flex justify-end gap-3">
            <ActionButton onClick={() => setDeleteModal({ open: false, video: null })} variant="secondary">Cancel</ActionButton>
            <ActionButton onClick={confirmDelete} isLoading={actionLoading} variant="danger">Delete</ActionButton>
          </div>
        </div>
      </Modal>
    </motion.div>
  );
}
