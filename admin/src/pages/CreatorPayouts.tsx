import React, { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  ActivityIcon,
  AlertTriangleIcon,
  BanknoteIcon,
  CheckCircleIcon,
  DollarSignIcon,
  PlayCircleIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  WalletIcon,
  XCircleIcon,
} from 'lucide-react';
import { DataTable, type Column } from '../components/shared/DataTable';
import { StatusBadge, type StatusColor } from '../components/shared/StatusBadge';
import { FilterBar } from '../components/shared/FilterBar';
import { Pagination } from '../components/shared/Pagination';
import { ActionButton } from '../components/shared/ActionButton';
import { StatsCard } from '../components/shared/StatsCard';
import { Modal } from '../components/shared/Modal';
import {
  approveCreatorPayout,
  fetchCreatorPayouts,
  markPayoutFailed,
  markPayoutPaid,
  markPayoutProcessing,
  rejectCreatorPayout,
  retryPayout,
  subscribeFinanceEvents,
  type CreatorPayout,
  type PayoutStats,
} from '../api/financeApi';

function fmtUsd(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(n || 0));
}

function fmtNgn(n: number | undefined) {
  if (!n) return null;
  return `NGN ${Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
}

function fmtDate(d?: string) {
  if (!d) return '-';
  return new Date(d).toLocaleString();
}

const statusColors: Record<string, StatusColor> = {
  pending: 'yellow',
  approved: 'blue',
  processing: 'blue',
  paid: 'green',
  completed: 'green',
  failed: 'red',
  rejected: 'red',
};

type ActionType = 'approve' | 'mark-processing' | 'mark-paid' | 'mark-failed' | 'retry' | 'reject';

const actionLabels: Record<ActionType, string> = {
  approve: 'Approve Payout',
  'mark-processing': 'Move to Processing',
  'mark-paid': 'Complete Payout',
  'mark-failed': 'Mark Failed',
  retry: 'Retry Payout',
  reject: 'Reject Payout',
};

export function CreatorPayouts() {
  const [payouts, setPayouts] = useState<CreatorPayout[]>([]);
  const [stats, setStats] = useState<PayoutStats | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(10);

  const [modalOpen, setModalOpen] = useState(false);
  const [actionType, setActionType] = useState<ActionType>('approve');
  const [selectedPayout, setSelectedPayout] = useState<CreatorPayout | null>(null);
  const [reason, setReason] = useState('');
  const [adminNotes, setAdminNotes] = useState('');
  const [transactionRef, setTransactionRef] = useState('');
  const [useGateway, setUseGateway] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetchCreatorPayouts({
        page: currentPage,
        limit: itemsPerPage,
        search,
        statusFilter,
      });
      setPayouts(res.payouts);
      setTotal(res.total);
      setStats(res.stats);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [currentPage, itemsPerPage, search, statusFilter]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => subscribeFinanceEvents(() => load()), [load]);

  const openModal = (payout: CreatorPayout, type: ActionType) => {
    setSelectedPayout(payout);
    setActionType(type);
    setReason('');
    setAdminNotes('');
    setTransactionRef(payout.transaction_reference || payout.paystack_transaction_reference || '');
    setUseGateway(false);
    setActionError('');
    setModalOpen(true);
  };

  const handleAction = async () => {
    if (!selectedPayout) return;
    if ((actionType === 'reject' || actionType === 'mark-failed') && !reason.trim()) {
      setActionError('Please provide a reason.');
      return;
    }

    setActionLoading(true);
    setActionError('');
    try {
      if (actionType === 'approve') {
        await approveCreatorPayout(selectedPayout.id, { notes: adminNotes });
      } else if (actionType === 'mark-processing') {
        await markPayoutProcessing(selectedPayout.id, { transactionReference: transactionRef, notes: adminNotes });
      } else if (actionType === 'mark-paid') {
        await markPayoutPaid(selectedPayout.id, {
          transactionReference: transactionRef,
          notes: adminNotes,
          provider: useGateway ? 'paystack' : 'manual',
          useGateway,
        });
      } else if (actionType === 'mark-failed') {
        await markPayoutFailed(selectedPayout.id, reason);
      } else if (actionType === 'retry') {
        await retryPayout(selectedPayout.id);
      } else {
        await rejectCreatorPayout(selectedPayout.id, reason);
      }

      setModalOpen(false);
      await load();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setActionLoading(false);
    }
  };

  const columns: Column<CreatorPayout>[] = [
    {
      key: 'creator_name',
      header: 'Creator',
      render: (item) => (
        <div>
          <div className="font-medium text-[13px] text-text-primary">{item.creator_name || 'Unknown creator'}</div>
          <div className="text-[12px] text-text-tertiary">{item.creator_email || item.creator_id}</div>
        </div>
      ),
    },
    {
      key: 'amount_usd',
      header: 'Amount',
      render: (item) => (
        <div>
          <span className="font-semibold text-[13px] text-text-primary">{fmtUsd(item.amount_usd)}</span>
          {item.amount_ngn ? <span className="block text-[11px] text-text-tertiary">{fmtNgn(item.amount_ngn)}</span> : null}
        </div>
      ),
    },
    {
      key: 'bank_name',
      header: 'Payout Method',
      render: (item) => (
        <div>
          <div className="text-[13px] text-text-secondary">{item.bank_name || item.method || 'Manual review'}</div>
          {item.account_number ? (
            <div className="text-[12px] text-text-tertiary">
              {item.account_number}
              {item.account_name ? <span> - {item.account_name}</span> : null}
            </div>
          ) : null}
          {item.transaction_reference ? (
            <div className="mt-0.5 font-mono text-[11px] text-text-tertiary">{item.transaction_reference}</div>
          ) : item.reference_id ? (
            <div className="mt-0.5 font-mono text-[11px] text-text-tertiary">{item.reference_id}</div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'risk_score',
      header: 'Risk',
      render: (item) => {
        const score = Number(item.risk_score || 0);
        if (!score) return <span className="text-[12px] text-text-tertiary">Normal</span>;
        const highRisk = score >= 50;
        return (
          <div className={`inline-flex items-center gap-1 text-[12px] ${highRisk ? 'text-warning' : 'text-text-secondary'}`}>
            <AlertTriangleIcon className="h-3.5 w-3.5" />
            {score}
          </div>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      render: (item) => <StatusBadge status={item.status} color={statusColors[item.status] || 'gray'} />,
    },
    {
      key: 'requested_at',
      header: 'Requested',
      render: (item) => <span className="text-[12px] text-text-tertiary">{fmtDate(item.requested_at)}</span>,
    },
    {
      key: 'actions' as keyof CreatorPayout,
      header: '',
      render: (item) => (
        <div className="flex items-center justify-end gap-1">
          {item.status === 'pending' ? (
            <>
              <button className="p-1.5 rounded hover:bg-success/10 text-text-tertiary hover:text-success transition-colors" title="Approve payout" onClick={() => openModal(item, 'approve')}>
                <CheckCircleIcon className="w-4 h-4" />
              </button>
              <button className="p-1.5 rounded hover:bg-danger/10 text-text-tertiary hover:text-danger transition-colors" title="Reject payout" onClick={() => openModal(item, 'reject')}>
                <XCircleIcon className="w-4 h-4" />
              </button>
            </>
          ) : null}
          {item.status === 'approved' ? (
            <>
              <button className="p-1.5 rounded hover:bg-accent/10 text-text-tertiary hover:text-accent transition-colors" title="Move to processing" onClick={() => openModal(item, 'mark-processing')}>
                <PlayCircleIcon className="w-4 h-4" />
              </button>
              <button className="p-1.5 rounded hover:bg-danger/10 text-text-tertiary hover:text-danger transition-colors" title="Reject payout" onClick={() => openModal(item, 'reject')}>
                <XCircleIcon className="w-4 h-4" />
              </button>
            </>
          ) : null}
          {item.status === 'processing' ? (
            <>
              <button className="p-1.5 rounded hover:bg-success/10 text-text-tertiary hover:text-success transition-colors" title="Complete payout" onClick={() => openModal(item, 'mark-paid')}>
                <BanknoteIcon className="w-4 h-4" />
              </button>
              <button className="p-1.5 rounded hover:bg-danger/10 text-text-tertiary hover:text-danger transition-colors" title="Mark failed" onClick={() => openModal(item, 'mark-failed')}>
                <XCircleIcon className="w-4 h-4" />
              </button>
            </>
          ) : null}
          {item.status === 'failed' ? (
            <button className="p-1.5 rounded hover:bg-warning/10 text-text-tertiary hover:text-warning transition-colors" title="Retry payout" onClick={() => openModal(item, 'retry')}>
              <RotateCcwIcon className="w-4 h-4" />
            </button>
          ) : null}
        </div>
      ),
    },
  ];

  const modalVariant = actionType === 'reject' || actionType === 'mark-failed' ? 'danger' : actionType === 'retry' ? 'warning' : 'primary';
  const submitLabel = actionType === 'mark-paid' && useGateway ? 'Pay with Paystack' : actionLabels[actionType].replace('Payout', '').trim();

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Creator Payouts</h1>
          <p className="text-[13px] text-text-tertiary mt-0.5">Review withdrawal requests, flag risk, and hand approved payouts to Finance Hub.</p>
        </div>
        <ActionButton variant="ghost" icon={RefreshCwIcon} onClick={load} isLoading={loading}>Refresh</ActionButton>
      </div>

      {error ? (
        <div className="bg-danger/10 border border-danger/20 rounded-lg p-4 text-danger text-[13px]">{error}</div>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
        <StatsCard title="Pending" value={stats ? fmtUsd(stats.pendingTotal) : '...'} icon={ActivityIcon} />
        <StatsCard title="Approved" value={stats ? fmtUsd(stats.approvedTotal || 0) : '...'} icon={CheckCircleIcon} />
        <StatsCard title="Processing" value={stats ? fmtUsd(stats.processingTotal || 0) : '...'} icon={BanknoteIcon} />
        <StatsCard title="Completed Month" value={stats ? fmtUsd(stats.processedThisMonth) : '...'} icon={DollarSignIcon} />
        <StatsCard title="High Risk" value={stats?.highRiskCount ?? '...'} icon={ShieldAlertIcon} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <StatsCard title="Creator Balances" value={stats ? fmtUsd(stats.totalCreatorBalances) : '...'} icon={WalletIcon} />
        <StatsCard title="Average Payout" value={stats ? fmtUsd(stats.avgPayout) : '...'} icon={DollarSignIcon} />
      </div>

      <div className="card overflow-hidden">
        <div className="p-4 border-b border-border-default">
          <FilterBar
            searchValue={search}
            onSearchChange={(v) => { setSearch(v); setCurrentPage(1); }}
            searchPlaceholder="Search creators..."
            filters={[{
              label: 'Status',
              value: statusFilter,
              onChange: (v) => { setStatusFilter(v); setCurrentPage(1); },
              options: [
                { label: 'All Statuses', value: '' },
                { label: 'Pending', value: 'pending' },
                { label: 'Approved', value: 'approved' },
                { label: 'Processing', value: 'processing' },
                { label: 'Completed', value: 'completed' },
                { label: 'Failed', value: 'failed' },
                { label: 'Rejected', value: 'rejected' },
              ],
            }]}
          />
        </div>

        <DataTable columns={columns} data={payouts} isLoading={loading} emptyMessage="No payout requests yet." />

        <Pagination
          currentPage={currentPage}
          totalPages={Math.max(1, Math.ceil(total / itemsPerPage))}
          totalItems={total}
          itemsPerPage={itemsPerPage}
          onPageChange={setCurrentPage}
          onItemsPerPageChange={(items) => { setItemsPerPage(items); setCurrentPage(1); }}
        />
      </div>

      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={actionLabels[actionType]}
        maxWidth="lg"
        footer={(
          <>
            <ActionButton variant="ghost" onClick={() => setModalOpen(false)}>Cancel</ActionButton>
            <ActionButton variant={modalVariant} onClick={handleAction} isLoading={actionLoading}>{submitLabel}</ActionButton>
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
              {selectedPayout.amount_ngn ? (
                <div className="flex justify-between gap-4">
                  <span className="text-text-tertiary">Converted Amount</span>
                  <span className="text-text-secondary">{fmtNgn(selectedPayout.amount_ngn)}</span>
                </div>
              ) : null}
              {selectedPayout.bank_name ? (
                <div className="flex justify-between gap-4">
                  <span className="text-text-tertiary">Bank</span>
                  <span className="text-text-secondary text-right">{selectedPayout.bank_name}</span>
                </div>
              ) : null}
              {selectedPayout.account_number ? (
                <div className="flex justify-between gap-4">
                  <span className="text-text-tertiary">Account</span>
                  <span className="text-text-secondary text-right">{selectedPayout.account_number}</span>
                </div>
              ) : null}
              {selectedPayout.reference_id ? (
                <div className="flex justify-between gap-4">
                  <span className="text-text-tertiary">Request Ref</span>
                  <span className="font-mono text-text-secondary text-[12px] text-right">{selectedPayout.reference_id}</span>
                </div>
              ) : null}
              {selectedPayout.risk_flags?.length ? (
                <div className="pt-2">
                  <div className="mb-1 text-[12px] text-warning">Risk indicators</div>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedPayout.risk_flags.map((flag) => (
                      <span key={flag} className="rounded border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] text-warning">{flag.replace(/_/g, ' ')}</span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {actionType === 'approve' ? (
            <p className="text-[13px] text-text-secondary">Approval locks the payout for finance review, sends the creator an approval notification, and queues finance assignment through QStash.</p>
          ) : null}

          {actionType === 'mark-processing' ? (
            <p className="text-[13px] text-text-secondary">Finance processing notifies the creator that payment is underway. The creator dashboard will show that processing may take up to 24 hours.</p>
          ) : null}

          {actionType === 'retry' ? (
            <p className="text-[13px] text-text-secondary">Retrying moves the payout back to processing and queues another verification workflow. Failed attempts remain in the audit trail.</p>
          ) : null}

          {(actionType === 'mark-processing' || actionType === 'mark-paid') ? (
            <div>
              <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Transaction reference</label>
              <input
                className="input-field w-full"
                placeholder="Gateway, bank, or manual reference"
                value={transactionRef}
                onChange={(e) => setTransactionRef(e.target.value)}
              />
            </div>
          ) : null}

          {actionType === 'mark-paid' ? (
            <label className="flex items-start gap-2 rounded-lg border border-border-default bg-bg-elevated p-3 text-[13px] text-text-secondary">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={useGateway}
                onChange={(e) => setUseGateway(e.target.checked)}
              />
              <span>Use Paystack transfer instead of manual completion. Manual completion should include a transaction reference or proof from Finance Hub.</span>
            </label>
          ) : null}

          {(actionType === 'approve' || actionType === 'mark-processing' || actionType === 'mark-paid') ? (
            <div>
              <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Internal notes</label>
              <textarea
                className="input-field min-h-[90px] w-full resize-none"
                placeholder="Visible only to admin and finance reviewers"
                value={adminNotes}
                onChange={(e) => setAdminNotes(e.target.value)}
              />
            </div>
          ) : null}

          {(actionType === 'reject' || actionType === 'mark-failed') ? (
            <div>
              <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
                Reason <span className="text-danger">*</span>
              </label>
              <textarea
                className={`input-field min-h-[90px] w-full resize-none ${actionError ? 'border-danger ring-1 ring-danger' : ''}`}
                placeholder={actionType === 'reject' ? 'Explain why this withdrawal is being rejected' : 'Explain why this payout failed'}
                value={reason}
                onChange={(e) => { setReason(e.target.value); if (actionError) setActionError(''); }}
              />
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
