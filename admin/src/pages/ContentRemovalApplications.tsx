import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertTriangleIcon,
  CheckCircleIcon,
  ClockIcon,
  EyeIcon,
  FileTextIcon,
  MailIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  SaveIcon,
  SearchIcon,
  XCircleIcon,
} from 'lucide-react';
import { ActionButton } from '../components/shared/ActionButton';
import { StatusBadge, type StatusColor } from '../components/shared/StatusBadge';
import { useToast } from '../contexts/ToastContext';
import {
  fetchContentRemovalRequests,
  sendContentRemovalFeedback,
  subscribeContentRemovalEvents,
  updateContentRemovalRequest,
  updateContentRemovalStatus,
  type ContentRemovalRequest,
  type ContentRemovalStatus,
} from '../api/contentRemovalApi';

const STATUS_FILTERS: { key: 'all' | ContentRemovalStatus; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'under_review', label: 'Under Review' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'needs_info', label: 'Needs Info' },
];

const STATUS_COLORS: Record<string, StatusColor> = {
  pending: 'yellow',
  under_review: 'blue',
  approved: 'green',
  rejected: 'red',
  needs_info: 'brand',
};

function statusLabel(status?: string) {
  return String(status || 'pending').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtDate(value?: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function deadlineLabel(value?: string | null) {
  if (!value) return 'No deadline';
  const ms = new Date(value).getTime() - Date.now();
  const days = Math.ceil(ms / (24 * 60 * 60 * 1000));
  if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`;
  if (days === 0) return 'Due today';
  return `${days} day${days === 1 ? '' : 's'} left`;
}

function fileSize(size?: number) {
  if (!size) return '';
  if (size < 1024 * 1024) return `${Math.round(size / 1024)}KB`;
  return `${(size / 1024 / 1024).toFixed(2)}MB`;
}

function makeDraft(request: ContentRemovalRequest | null) {
  return {
    full_name: request?.full_name || '',
    email: request?.email || '',
    company: request?.company || '',
    phone: request?.phone || '',
    relationship_to_content: request?.relationship_to_content || '',
    content_url: request?.content_url || '',
    additional_urls: (request?.additional_urls || []).join('\n'),
    content_title: request?.content_title || '',
    reason: request?.reason || '',
    notes: request?.notes || '',
    evidence_notes: request?.evidence_notes || '',
    admin_notes: request?.admin_notes || '',
    digital_signature: request?.digital_signature || '',
    consent_accuracy: request?.consent_accuracy ?? true,
    consent_authorized: request?.consent_authorized ?? true,
  };
}

export function ContentRemovalApplications() {
  const toast = useToast();
  const [requests, setRequests] = useState<ContentRemovalRequest[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | ContentRemovalStatus>('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [acting, setActing] = useState('');
  const [error, setError] = useState('');
  const [feedbackMessage, setFeedbackMessage] = useState('');

  const selected = useMemo(
    () => requests.find((request) => request.id === selectedId || request.request_id === selectedId) || requests[0] || null,
    [requests, selectedId],
  );
  const [draft, setDraft] = useState(() => makeDraft(selected));

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await fetchContentRemovalRequests({ status: statusFilter, search, limit: 75 });
      setRequests(result.data || []);
      setSelectedId((current) => current || result.data?.[0]?.id || '');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    setDraft(makeDraft(selected));
    setFeedbackMessage(selected?.feedback_message || '');
  }, [selected?.id]);

  useEffect(() => {
    return subscribeContentRemovalEvents(() => load());
  }, [load]);

  const counts = useMemo(() => ({
    pending: requests.filter((r) => r.status === 'pending').length,
    underReview: requests.filter((r) => r.status === 'under_review').length,
    overdue: requests.filter((r) => r.overdue).length,
    final: requests.filter((r) => ['approved', 'rejected'].includes(r.status)).length,
  }), [requests]);

  const saveDraft = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const payload = {
        ...draft,
        additional_urls: draft.additional_urls.split(/\r?\n/).map((url) => url.trim()).filter(Boolean),
      };
      const result = await updateContentRemovalRequest(selected.id, payload);
      setRequests((prev) => prev.map((item) => item.id === result.data.id ? result.data : item));
      toast.success('Request information saved.');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const changeStatus = async (status: ContentRemovalStatus) => {
    if (!selected) return;
    setActing(status);
    try {
      const defaultMessages: Record<ContentRemovalStatus, string> = {
        pending: 'This request has been reopened for review.',
        under_review: 'Your request is now under review by our Trust & Safety team.',
        approved: 'Your request was approved. The reported content will be removed or actioned according to platform policy.',
        rejected: 'Your request was not approved based on the information provided and our platform policies.',
        needs_info: 'Please provide additional proof or clarification so we can continue the review.',
      };
      const result = await updateContentRemovalStatus(selected.id, status, feedbackMessage || defaultMessages[status]);
      setRequests((prev) => prev.map((item) => item.id === result.data.id ? result.data : item));
      toast.success(`Request marked ${statusLabel(status)}.`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setActing('');
    }
  };

  const sendFeedback = async () => {
    if (!selected || !feedbackMessage.trim()) {
      toast.error('Write feedback before sending.');
      return;
    }
    setActing('feedback');
    try {
      const result = await sendContentRemovalFeedback(selected.id, feedbackMessage);
      setRequests((prev) => prev.map((item) => item.id === result.data.id ? result.data : item));
      toast.success('Feedback email sent.');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setActing('');
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Content Removal Applications</h1>
          <p className="mt-1 text-[13px] text-text-tertiary">
            Review legal removal requests, evidence, deadlines, status emails, and admin feedback.
          </p>
        </div>
        <ActionButton icon={RefreshCwIcon} variant="secondary" onClick={load} isLoading={loading}>
          Refresh
        </ActionButton>
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-danger/20 bg-danger/10 p-4 text-[13px] text-danger">
          <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: 'Pending', value: counts.pending, icon: ClockIcon },
          { label: 'Under Review', value: counts.underReview, icon: EyeIcon },
          { label: 'Overdue', value: counts.overdue, icon: AlertTriangleIcon },
          { label: 'Final Decisions', value: counts.final, icon: CheckCircleIcon },
        ].map(({ label, value, icon: Icon }) => (
          <div key={label} className="card p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-text-tertiary">{label}</p>
                <p className="mt-1 text-2xl font-semibold text-text-primary">{value}</p>
              </div>
              <Icon className="h-5 w-5 text-text-tertiary" />
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="card overflow-hidden">
          <div className="border-b border-border-default p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="relative w-full lg:max-w-sm">
                <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary" />
                <input
                  className="input-field w-full pl-9"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search email, request ID, or content URL..."
                />
              </div>
              <div className="flex flex-wrap gap-2">
                {STATUS_FILTERS.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setStatusFilter(item.key)}
                    className={`rounded-lg border px-3 py-1.5 text-[12px] font-medium transition ${
                      statusFilter === item.key
                        ? 'border-accent bg-accent text-white'
                        : 'border-border-default bg-bg-elevated text-text-secondary hover:border-accent/50'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {loading ? (
            <div className="space-y-3 p-5">
              {[1, 2, 3, 4].map((item) => <div key={item} className="h-16 animate-pulse rounded-lg bg-bg-elevated" />)}
            </div>
          ) : requests.length === 0 ? (
            <div className="flex min-h-[260px] flex-col items-center justify-center gap-3 p-8 text-center">
              <FileTextIcon className="h-10 w-10 text-text-tertiary" />
              <div>
                <p className="font-medium text-text-primary">No content removal applications</p>
                <p className="mt-1 text-[13px] text-text-tertiary">New public submissions will appear here automatically.</p>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border-default bg-bg-base text-[11px] uppercase tracking-wider text-text-tertiary">
                  <tr>
                    <th className="px-4 py-3 font-medium">Request</th>
                    <th className="px-4 py-3 font-medium">Requester</th>
                    <th className="px-4 py-3 font-medium">Content URL</th>
                    <th className="px-4 py-3 font-medium">Deadline</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((request) => {
                    const active = selected?.id === request.id;
                    return (
                      <tr
                        key={request.id}
                        onClick={() => setSelectedId(request.id)}
                        className={`cursor-pointer border-b border-border-subtle transition hover:bg-bg-elevated/60 ${active ? 'bg-bg-elevated' : ''}`}
                      >
                        <td className="px-4 py-3">
                          <p className="font-mono text-[12px] font-semibold text-text-primary">{request.request_id}</p>
                          <p className="mt-1 text-[11px] text-text-tertiary">{fmtDate(request.submitted_at)}</p>
                        </td>
                        <td className="px-4 py-3">
                          <p className="max-w-[180px] truncate font-medium text-text-primary">{request.full_name}</p>
                          <p className="max-w-[180px] truncate text-[12px] text-text-tertiary">{request.email}</p>
                        </td>
                        <td className="px-4 py-3">
                          <p className="max-w-[260px] truncate text-[12px] text-text-secondary">{request.content_url}</p>
                          <p className="mt-1 text-[11px] text-text-tertiary">{request.reason}</p>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-[12px] font-medium ${request.overdue ? 'text-danger' : 'text-text-secondary'}`}>
                            {deadlineLabel(request.deadline_at)}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge status={statusLabel(request.status)} color={STATUS_COLORS[request.status] || 'gray'} dot />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <aside className="card h-fit overflow-hidden xl:sticky xl:top-5">
          {!selected ? (
            <div className="p-6 text-sm text-text-tertiary">Select a request to review details.</div>
          ) : (
            <>
              <div className="border-b border-border-default p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-[12px] font-semibold text-accent">{selected.request_id}</p>
                    <h2 className="mt-1 truncate text-lg font-semibold text-text-primary">{selected.full_name}</h2>
                    <p className="mt-1 truncate text-[13px] text-text-tertiary">{selected.email}</p>
                  </div>
                  <StatusBadge status={statusLabel(selected.status)} color={STATUS_COLORS[selected.status] || 'gray'} dot />
                </div>
                {selected.overdue && (
                  <div className="mt-3 flex items-center gap-2 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-[12px] text-danger">
                    <AlertTriangleIcon className="h-3.5 w-3.5" />
                    Review deadline is overdue.
                  </div>
                )}
              </div>

              <div className="max-h-[calc(100vh-190px)] space-y-5 overflow-y-auto p-5">
                <section className="space-y-3">
                  <h3 className="text-[12px] font-semibold uppercase tracking-wider text-text-tertiary">Request Details</h3>
                  <div className="grid gap-3">
                    <input className="input-field" value={draft.full_name} onChange={(e) => setDraft((p) => ({ ...p, full_name: e.target.value }))} placeholder="Full name" />
                    <input className="input-field" value={draft.email} onChange={(e) => setDraft((p) => ({ ...p, email: e.target.value }))} placeholder="Email" />
                    <input className="input-field" value={draft.phone} onChange={(e) => setDraft((p) => ({ ...p, phone: e.target.value }))} placeholder="Phone" />
                    <input className="input-field" value={draft.company} onChange={(e) => setDraft((p) => ({ ...p, company: e.target.value }))} placeholder="Company" />
                    <input className="input-field" value={draft.content_url} onChange={(e) => setDraft((p) => ({ ...p, content_url: e.target.value }))} placeholder="Content URL" />
                    <input className="input-field" value={draft.reason} onChange={(e) => setDraft((p) => ({ ...p, reason: e.target.value }))} placeholder="Reason" />
                    <textarea className="input-field min-h-20 resize-y" value={draft.additional_urls} onChange={(e) => setDraft((p) => ({ ...p, additional_urls: e.target.value }))} placeholder="Additional URLs, one per line" />
                    <textarea className="input-field min-h-28 resize-y" value={draft.notes} onChange={(e) => setDraft((p) => ({ ...p, notes: e.target.value }))} placeholder="Reason details" />
                    <textarea className="input-field min-h-24 resize-y" value={draft.evidence_notes} onChange={(e) => setDraft((p) => ({ ...p, evidence_notes: e.target.value }))} placeholder="Evidence notes" />
                    <textarea className="input-field min-h-28 resize-y" value={draft.admin_notes} onChange={(e) => setDraft((p) => ({ ...p, admin_notes: e.target.value }))} placeholder="Private admin notes" />
                    <ActionButton icon={SaveIcon} onClick={saveDraft} isLoading={saving}>Save Request</ActionButton>
                  </div>
                </section>

                <section className="space-y-3">
                  <h3 className="text-[12px] font-semibold uppercase tracking-wider text-text-tertiary">Uploaded Evidence</h3>
                  {selected.files?.length ? (
                    <div className="space-y-2">
                      {selected.files.map((file) => (
                        <a
                          key={`${file.path}-${file.name}`}
                          href={file.signedUrl || '#'}
                          target="_blank"
                          rel="noreferrer"
                          className="block rounded-lg border border-border-subtle bg-bg-elevated p-3 hover:border-accent/40"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="truncate text-[13px] font-medium text-text-primary">{file.originalName || file.name || 'Evidence file'}</span>
                            <span className="shrink-0 text-[11px] text-text-tertiary">{fileSize(file.size)}</span>
                          </div>
                          {file.mimeType?.startsWith('image/') && file.signedUrl && (
                            <img src={file.signedUrl} alt="" className="mt-3 max-h-40 w-full rounded-md object-cover" />
                          )}
                        </a>
                      ))}
                    </div>
                  ) : (
                    <p className="rounded-lg border border-border-subtle bg-bg-elevated p-3 text-[13px] text-text-tertiary">No evidence files uploaded.</p>
                  )}
                </section>

                <section className="space-y-3">
                  <h3 className="text-[12px] font-semibold uppercase tracking-wider text-text-tertiary">Feedback Email</h3>
                  <textarea
                    className="input-field min-h-28 resize-y"
                    value={feedbackMessage}
                    onChange={(event) => setFeedbackMessage(event.target.value)}
                    placeholder="Write the message that should be emailed to the requester..."
                  />
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <ActionButton icon={EyeIcon} variant="secondary" onClick={() => changeStatus('under_review')} isLoading={acting === 'under_review'}>Under Review</ActionButton>
                    <ActionButton icon={CheckCircleIcon} variant="secondary" onClick={() => changeStatus('approved')} isLoading={acting === 'approved'}>Approve</ActionButton>
                    <ActionButton icon={XCircleIcon} variant="danger" onClick={() => changeStatus('rejected')} isLoading={acting === 'rejected'}>Reject</ActionButton>
                    <ActionButton icon={MailIcon} variant="warning" onClick={() => changeStatus('needs_info')} isLoading={acting === 'needs_info'}>Need Info</ActionButton>
                  </div>
                  <ActionButton icon={MessageSquareIcon} variant="primary" onClick={sendFeedback} isLoading={acting === 'feedback'} className="w-full">
                    Send Feedback
                  </ActionButton>
                </section>

                <section className="space-y-3">
                  <h3 className="text-[12px] font-semibold uppercase tracking-wider text-text-tertiary">Timeline</h3>
                  <div className="space-y-2">
                    <div className="rounded-lg border border-border-subtle bg-bg-elevated p-3 text-[12px] text-text-secondary">
                      <strong>Submitted:</strong> {fmtDate(selected.submitted_at)}
                      <br />
                      <strong>Review started:</strong> {fmtDate(selected.review_started_at)}
                      <br />
                      <strong>Decision:</strong> {fmtDate(selected.decision_at)}
                      <br />
                      <strong>Deadline:</strong> {fmtDate(selected.deadline_at)}
                    </div>
                    {(selected.activity || []).map((item) => (
                      <div key={item.id || `${item.at}-${item.message}`} className="rounded-lg border border-border-subtle p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[12px] font-medium text-text-primary">{item.type || 'activity'}</span>
                          <span className="text-[11px] text-text-tertiary">{fmtDate(item.at)}</span>
                        </div>
                        <p className="mt-1 text-[12px] text-text-secondary">{item.message}</p>
                        {item.actor && <p className="mt-1 text-[11px] text-text-tertiary">By {item.actor}</p>}
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            </>
          )}
        </aside>
      </div>
    </motion.div>
  );
}
