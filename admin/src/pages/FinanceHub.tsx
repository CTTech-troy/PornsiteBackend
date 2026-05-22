import React, { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertTriangleIcon,
  BanknoteIcon,
  CheckCircleIcon,
  ClockIcon,
  DownloadIcon,
  PlayCircleIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SendIcon,
  UploadIcon,
  XCircleIcon,
} from 'lucide-react';
import { ActionButton } from '../components/shared/ActionButton';
import { Modal } from '../components/shared/Modal';
import { StatusBadge, type StatusColor } from '../components/shared/StatusBadge';
import {
  fetchCreatorPayouts,
  fetchFinanceSummary,
  fetchPayoutAnalytics,
  markPayoutFailed,
  markPayoutPaid,
  markPayoutProcessing,
  payoutExportUrl,
  retryPayout,
  subscribeFinanceEvents,
  uploadPayoutProof,
  type CreatorPayout,
  type FinanceSummary,
  type PayoutAnalytics,
} from '../api/financeApi';

function fmtUsd(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(n || 0));
}

function fmtNgn(n?: number | null) {
  if (!n) return null;
  return `NGN ${Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
}

function fmtDate(d?: string | null) {
  if (!d) return '-';
  return new Date(d).toLocaleString();
}

const statusColors: Record<string, StatusColor> = {
  active: 'green',
  approved: 'blue',
  cancelled: 'red',
  completed: 'green',
  expired: 'gray',
  failed: 'red',
  paid: 'green',
  pending: 'yellow',
  processing: 'blue',
  rejected: 'red',
};

type ActionType = 'mark-processing' | 'mark-paid' | 'mark-failed' | 'retry' | 'upload-proof';

const actionTitles: Record<ActionType, string> = {
  'mark-processing': 'Start Finance Processing',
  'mark-paid': 'Complete Payout',
  'mark-failed': 'Mark Payout Failed',
  retry: 'Retry Failed Payout',
  'upload-proof': 'Upload Payment Proof',
};

export function FinanceHub() {
  const [data, setData] = useState<FinanceSummary | null>(null);
  const [analytics, setAnalytics] = useState<PayoutAnalytics | null>(null);
  const [payoutQueue, setPayoutQueue] = useState<CreatorPayout[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');

  const [modalOpen, setModalOpen] = useState(false);
  const [selectedPayout, setSelectedPayout] = useState<CreatorPayout | null>(null);
  const [actionType, setActionType] = useState<ActionType>('mark-processing');
  const [transactionRef, setTransactionRef] = useState('');
  const [provider, setProvider] = useState('manual');
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [summary, analyticsRes, approved, processing, failed] = await Promise.all([
        fetchFinanceSummary(),
        fetchPayoutAnalytics(),
        fetchCreatorPayouts({ page: 1, limit: 15, statusFilter: 'approved' }),
        fetchCreatorPayouts({ page: 1, limit: 15, statusFilter: 'processing' }),
        fetchCreatorPayouts({ page: 1, limit: 10, statusFilter: 'failed' }),
      ]);

      const queue = [...approved.payouts, ...processing.payouts, ...failed.payouts]
        .sort((a, b) => new Date(b.requested_at).getTime() - new Date(a.requested_at).getTime());

      setData(summary);
      setAnalytics(analyticsRes.analytics);
      setPayoutQueue(queue);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => subscribeFinanceEvents(() => load()), [load]);

  const openModal = (payout: CreatorPayout, type: ActionType) => {
    setSelectedPayout(payout);
    setActionType(type);
    setTransactionRef(payout.transaction_reference || payout.paystack_transaction_reference || '');
    setProvider('manual');
    setNotes('');
    setReason('');
    setProofFile(null);
    setActionError('');
    setModalOpen(true);
  };

  const handleAction = async () => {
    if (!selectedPayout) return;
    if (actionType === 'mark-failed' && !reason.trim()) {
      setActionError('Please provide the failure reason.');
      return;
    }
    if (actionType === 'upload-proof' && !proofFile) {
      setActionError('Please choose the proof of payment file.');
      return;
    }

    setActionLoading(true);
    setActionError('');
    try {
      if (actionType === 'mark-processing') {
        await markPayoutProcessing(selectedPayout.id, { transactionReference: transactionRef, notes });
      } else if (actionType === 'mark-paid') {
        await markPayoutPaid(selectedPayout.id, { transactionReference: transactionRef, provider, notes });
      } else if (actionType === 'mark-failed') {
        await markPayoutFailed(selectedPayout.id, reason);
      } else if (actionType === 'retry') {
        await retryPayout(selectedPayout.id);
      } else if (proofFile) {
        await uploadPayoutProof(selectedPayout.id, proofFile, { transactionReference: transactionRef, provider, notes });
      }

      setModalOpen(false);
      await load();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setActionLoading(false);
    }
  };

  const downloadPayoutReport = async () => {
    setExporting(true);
    setError('');
    try {
      const res = await fetch(payoutExportUrl(), {
        headers: { Authorization: `Bearer ${localStorage.getItem('admin_token') || ''}` },
      });
      if (!res.ok) throw new Error(await res.text() || 'Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `creator-payouts-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const stats = [
    { label: 'Total Revenue', value: data ? fmtUsd(data.totalRevenue) : '-' },
    { label: 'Pending Payouts', value: data ? fmtUsd(data.pendingPayouts) : '-' },
    { label: 'Approved Queue', value: analytics ? analytics.approvedPayouts : '-' },
    { label: 'Processing Queue', value: analytics ? analytics.processingPayouts : '-' },
    { label: 'Failed Payouts', value: analytics ? analytics.failedPayouts : '-' },
    { label: 'Avg Processing', value: analytics ? `${analytics.avgProcessingHours.toFixed(1)}h` : '-' },
  ];

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Finance Hub</h1>
          <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">
            Process creator payouts, verify payment proof, and track finance operations.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ActionButton variant="ghost" icon={RefreshCwIcon} onClick={load} isLoading={loading}>Refresh</ActionButton>
          <ActionButton variant="secondary" icon={DownloadIcon} onClick={downloadPayoutReport} isLoading={exporting}>Export CSV</ActionButton>
          <ActionButton variant="secondary" icon={SendIcon} disabled title="Daily summaries are generated by QStash">
            QStash Summary
          </ActionButton>
        </div>
      </div>

      {error ? (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-600 dark:text-red-400 text-sm">
          {error}
        </div>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-4">
        {stats.map((s) => (
          <div key={s.label} className="card p-5">
            <h3 className="text-[11px] font-medium text-slate-500 uppercase tracking-wider mb-1">{s.label}</h3>
            {loading
              ? <div className="h-7 w-24 bg-slate-200 dark:bg-slate-700 animate-pulse rounded" />
              : <p className="text-2xl font-bold text-slate-900 dark:text-white">{s.value}</p>}
          </div>
        ))}
      </div>

      <div className="card p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Payout Processing Queue</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">Approved payouts are assigned here by QStash. Completed and failed actions are audited.</p>
          </div>
          {analytics?.highRiskCount ? (
            <div className="inline-flex items-center gap-1.5 rounded-md border border-amber-300/50 bg-amber-100/60 px-2.5 py-1 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
              <AlertTriangleIcon className="h-3.5 w-3.5" />
              {analytics.highRiskCount} risk flags
            </div>
          ) : null}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-600 dark:text-slate-300">
            <thead className="text-xs uppercase bg-slate-50 dark:bg-slate-800/50 text-slate-500 dark:text-slate-400">
              <tr>
                <th className="px-4 py-3 font-medium rounded-l-lg">Creator</th>
                <th className="px-4 py-3 font-medium">Amount</th>
                <th className="px-4 py-3 font-medium">Method</th>
                <th className="px-4 py-3 font-medium">Reference</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium rounded-r-lg text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {loading
                ? Array.from({ length: 4 }).map((_, i) => (
                    <tr key={i}>
                      {Array.from({ length: 6 }).map((__, j) => (
                        <td key={j} className="px-4 py-3">
                          <div className="h-4 bg-slate-200 dark:bg-slate-700 animate-pulse rounded w-24" />
                        </td>
                      ))}
                    </tr>
                  ))
                : payoutQueue.length === 0
                ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-slate-400">
                        No approved or processing payouts right now.
                      </td>
                    </tr>
                  )
                : payoutQueue.map((p) => (
                    <tr key={p.id}>
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-900 dark:text-white">{p.creator_name || 'Creator'}</div>
                        <div className="text-xs text-slate-400">{p.creator_email || p.creator_id}</div>
                      </td>
                      <td className="px-4 py-3 font-medium text-slate-900 dark:text-white">
                        {fmtUsd(p.amount_usd)}
                        {p.amount_ngn ? <span className="block text-xs font-normal text-slate-400">{fmtNgn(p.amount_ngn)}</span> : null}
                      </td>
                      <td className="px-4 py-3">
                        <div>{p.bank_name || p.method || 'Manual'}</div>
                        {p.account_number ? <div className="text-xs text-slate-400">{p.account_number}</div> : null}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">{p.transaction_reference || p.reference_id || '-'}</td>
                      <td className="px-4 py-3">
                        <StatusBadge status={p.status} color={statusColors[p.status] || 'gray'} />
                        {p.failure_reason ? <p className="mt-1 max-w-[240px] text-xs text-red-500">{p.failure_reason}</p> : null}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          {p.status === 'approved' ? (
                            <button className="p-1.5 rounded hover:bg-blue-500/10 text-slate-400 hover:text-blue-500" title="Start processing" onClick={() => openModal(p, 'mark-processing')}>
                              <PlayCircleIcon className="h-4 w-4" />
                            </button>
                          ) : null}
                          {p.status === 'processing' ? (
                            <>
                              <button className="p-1.5 rounded hover:bg-emerald-500/10 text-slate-400 hover:text-emerald-500" title="Complete payout" onClick={() => openModal(p, 'mark-paid')}>
                                <CheckCircleIcon className="h-4 w-4" />
                              </button>
                              <button className="p-1.5 rounded hover:bg-indigo-500/10 text-slate-400 hover:text-indigo-500" title="Upload proof" onClick={() => openModal(p, 'upload-proof')}>
                                <UploadIcon className="h-4 w-4" />
                              </button>
                              <button className="p-1.5 rounded hover:bg-red-500/10 text-slate-400 hover:text-red-500" title="Mark failed" onClick={() => openModal(p, 'mark-failed')}>
                                <XCircleIcon className="h-4 w-4" />
                              </button>
                            </>
                          ) : null}
                          {p.status === 'failed' ? (
                            <button className="p-1.5 rounded hover:bg-amber-500/10 text-slate-400 hover:text-amber-500" title="Retry payout" onClick={() => openModal(p, 'retry')}>
                              <RotateCcwIcon className="h-4 w-4" />
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="card p-6">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-4">Recent Transactions</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-600 dark:text-slate-300">
              <thead className="text-xs uppercase bg-slate-50 dark:bg-slate-800/50 text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-3 font-medium rounded-l-lg">Type</th>
                  <th className="px-4 py-3 font-medium">User</th>
                  <th className="px-4 py-3 font-medium">Amount</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium rounded-r-lg">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {loading
                  ? Array.from({ length: 5 }).map((_, i) => (
                      <tr key={i}>
                        {Array.from({ length: 5 }).map((__, j) => (
                          <td key={j} className="px-4 py-3">
                            <div className="h-4 bg-slate-200 dark:bg-slate-700 animate-pulse rounded w-20" />
                          </td>
                        ))}
                      </tr>
                    ))
                  : (data?.recentTransactions || []).length === 0
                  ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-8 text-center text-slate-400">No transactions yet.</td>
                      </tr>
                    )
                  : data?.recentTransactions.map((t) => (
                      <tr key={t.id}>
                        <td className="px-4 py-3">{t.type}</td>
                        <td className="px-4 py-3 text-sm text-slate-700 dark:text-slate-300">{t.userName || '-'}</td>
                        <td className="px-4 py-3 font-medium text-slate-900 dark:text-white">{fmtUsd(t.amount)}</td>
                        <td className="px-4 py-3"><StatusBadge status={t.status} color={statusColors[t.status] || 'gray'} /></td>
                        <td className="px-4 py-3 text-slate-500">{fmtDate(t.date)}</td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card p-6">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-4">Creator Payout Status Feed</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-600 dark:text-slate-300">
              <thead className="text-xs uppercase bg-slate-50 dark:bg-slate-800/50 text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-3 font-medium rounded-l-lg">Creator</th>
                  <th className="px-4 py-3 font-medium">Amount</th>
                  <th className="px-4 py-3 font-medium">Reference</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium rounded-r-lg">Payment Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {loading
                  ? Array.from({ length: 4 }).map((_, i) => (
                      <tr key={i}>
                        {Array.from({ length: 5 }).map((__, j) => (
                          <td key={j} className="px-4 py-3">
                            <div className="h-4 bg-slate-200 dark:bg-slate-700 animate-pulse rounded w-24" />
                          </td>
                        ))}
                      </tr>
                    ))
                  : (data?.payoutLogs || []).length === 0
                  ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-8 text-center text-slate-400">No payout activity yet.</td>
                      </tr>
                    )
                  : data?.payoutLogs?.map((p) => (
                      <tr key={p.id}>
                        <td className="px-4 py-3">
                          <div className="font-medium text-slate-900 dark:text-white">{p.creator_name || 'Creator'}</div>
                          <div className="text-xs text-slate-400">{p.creator_id}</div>
                        </td>
                        <td className="px-4 py-3 font-medium text-slate-900 dark:text-white">
                          {fmtUsd(p.amount_usd)}
                          {p.amount_ngn ? <span className="block text-xs font-normal text-slate-400">{fmtNgn(p.amount_ngn)}</span> : null}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs">{p.transaction_reference || '-'}</td>
                        <td className="px-4 py-3">
                          <StatusBadge status={p.payout_status} color={statusColors[p.payout_status] || 'gray'} />
                          {p.error_message ? <p className="mt-1 text-xs text-red-500 max-w-[220px]">{p.error_message}</p> : null}
                        </td>
                        <td className="px-4 py-3 text-slate-500">{fmtDate(p.payment_date || p.created_at)}</td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={actionTitles[actionType]}
        maxWidth="lg"
        footer={(
          <>
            <ActionButton variant="ghost" onClick={() => setModalOpen(false)}>Cancel</ActionButton>
            <ActionButton
              variant={actionType === 'mark-failed' ? 'danger' : actionType === 'retry' ? 'warning' : 'primary'}
              onClick={handleAction}
              isLoading={actionLoading}
            >
              {actionType === 'upload-proof' ? 'Upload and Complete' : actionTitles[actionType].replace('Payout', '').trim()}
            </ActionButton>
          </>
        )}
      >
        <div className="space-y-4">
          {selectedPayout ? (
            <div className="bg-bg-elevated rounded-lg p-3 space-y-1.5 text-[13px]">
              <div className="flex justify-between gap-4">
                <span className="text-text-tertiary">Creator</span>
                <span className="font-medium text-text-primary text-right">{selectedPayout.creator_name || selectedPayout.creator_id}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-text-tertiary">Amount</span>
                <span className="font-semibold text-text-primary">{fmtUsd(selectedPayout.amount_usd)}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-text-tertiary">Status</span>
                <StatusBadge status={selectedPayout.status} color={statusColors[selectedPayout.status] || 'gray'} />
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-text-tertiary">Requested</span>
                <span className="text-text-secondary text-right">{fmtDate(selectedPayout.requested_at)}</span>
              </div>
            </div>
          ) : null}

          {(actionType === 'mark-processing' || actionType === 'mark-paid' || actionType === 'upload-proof') ? (
            <>
              <div>
                <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Transaction reference</label>
                <input className="input-field w-full" value={transactionRef} onChange={(e) => setTransactionRef(e.target.value)} placeholder="Bank, gateway, or internal reference" />
              </div>
              <div>
                <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Provider</label>
                <select className="input-field w-full" value={provider} onChange={(e) => setProvider(e.target.value)}>
                  <option value="manual">Manual</option>
                  <option value="paystack">Paystack</option>
                  <option value="bank_transfer">Bank transfer</option>
                  <option value="wire">Wire</option>
                </select>
              </div>
            </>
          ) : null}

          {actionType === 'upload-proof' ? (
            <div>
              <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Proof of payment</label>
              <input className="input-field w-full" type="file" accept="image/*,.pdf" onChange={(e) => setProofFile(e.target.files?.[0] || null)} />
            </div>
          ) : null}

          {(actionType === 'mark-processing' || actionType === 'mark-paid' || actionType === 'upload-proof') ? (
            <div>
              <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Finance notes</label>
              <textarea className="input-field min-h-[90px] w-full resize-none" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Internal finance notes" />
            </div>
          ) : null}

          {actionType === 'mark-failed' ? (
            <div>
              <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
                Failure reason <span className="text-danger">*</span>
              </label>
              <textarea className={`input-field min-h-[90px] w-full resize-none ${actionError ? 'border-danger ring-1 ring-danger' : ''}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Bank rejection, gateway failure, compliance hold, etc." />
            </div>
          ) : null}

          {actionType === 'retry' ? (
            <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-[13px] text-warning">
              Retrying moves the payout back to processing and creates another verification workflow while preserving the failed attempt in the audit trail.
            </div>
          ) : null}

          {actionType === 'mark-processing' ? (
            <div className="flex items-center gap-2 rounded-lg border border-border-default bg-bg-elevated p-3 text-[13px] text-text-secondary">
              <ClockIcon className="h-4 w-4 text-text-tertiary" />
              The creator will see that payment processing may take up to 24 hours.
            </div>
          ) : null}

          {actionError ? (
            <div className="bg-danger/10 border border-danger/20 rounded-lg px-3 py-2 text-danger text-[12px]">{actionError}</div>
          ) : null}
        </div>
      </Modal>
    </motion.div>
  );
}
