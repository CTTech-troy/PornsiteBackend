import React, { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { DollarSignIcon, CreditCardIcon, RefreshCcwIcon, DownloadIcon, AlertCircleIcon, RefreshCwIcon } from 'lucide-react';
import { DataTable, type Column } from '../components/shared/DataTable';
import { StatusBadge, type StatusColor } from '../components/shared/StatusBadge';
import { FilterBar } from '../components/shared/FilterBar';
import { Pagination } from '../components/shared/Pagination';
import { ActionButton } from '../components/shared/ActionButton';
import { StatsCard } from '../components/shared/StatsCard';
import { Modal } from '../components/shared/Modal';
import {
  fetchFraudAlerts,
  fetchPaymentAudit,
  fetchPaymentReconciliation,
  fetchPayments,
  fetchWebhookEvents,
  type FraudAlert,
  type Payment,
  type PaymentStats,
  type WebhookEvent,
} from '../api/financeApi';

function fmtUsd(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function fmtDate(d: string) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString();
}

const statusColors: Record<string, StatusColor> = {
  completed: 'green',
  fulfilled: 'green',
  paid: 'green',
  pending: 'yellow',
  created: 'yellow',
  checkout_created: 'yellow',
  processing: 'yellow',
  failed: 'red',
  suspicious: 'red',
  refunded: 'blue',
  active: 'green',
  expired: 'gray',
};

type PaymentsTab = 'payments' | 'fraud' | 'webhooks' | 'reconciliation';

export function Payments() {
  const [activeTab, setActiveTab] = useState<PaymentsTab>('payments');
  const [payments, setPayments] = useState<Payment[]>([]);
  const [stats, setStats] = useState<PaymentStats | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fraudAlerts, setFraudAlerts] = useState<FraudAlert[]>([]);
  const [webhookEvents, setWebhookEvents] = useState<WebhookEvent[]>([]);
  const [reconciliation, setReconciliation] = useState<Record<string, unknown> | null>(null);
  const [auditData, setAuditData] = useState<{
    intent: Record<string, unknown>;
    auditLogs: Array<Record<string, unknown>>;
    transactions: Array<Record<string, unknown>>;
  } | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [methodFilter, setMethodFilter] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(10);

  const [isRefundModalOpen, setIsRefundModalOpen] = useState(false);
  const [selectedPayment, setSelectedPayment] = useState<Payment | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetchPayments({
        page: currentPage,
        limit: itemsPerPage,
        search,
        statusFilter,
        methodFilter,
      });
      setPayments(res.payments);
      setTotal(res.total);
      setStats(res.stats);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [currentPage, itemsPerPage, search, statusFilter, methodFilter]);

  const loadFraud = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetchFraudAlerts({ page: 1, limit: 50, status: 'open' });
      setFraudAlerts(res.alerts);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadWebhooks = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetchWebhookEvents({ page: 1, limit: 50 });
      setWebhookEvents(res.events);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadReconciliation = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetchPaymentReconciliation(24);
      setReconciliation(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const openAudit = async (payment: Payment) => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchPaymentAudit(payment.id);
      setAuditData(data);
      setAuditOpen(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'payments') load();
    if (activeTab === 'fraud') loadFraud();
    if (activeTab === 'webhooks') loadWebhooks();
    if (activeTab === 'reconciliation') loadReconciliation();
  }, [activeTab, load, loadFraud, loadWebhooks, loadReconciliation]);

  const columns: Column<Payment>[] = [
    {
      key: 'reference',
      header: 'Reference',
      render: (item) => <span className="font-mono text-xs">{item.reference}</span>,
    },
    {
      key: 'name',
      header: 'User',
      render: (item) => (
        <div>
          <div className="font-medium text-[13px] text-text-primary">{item.name}</div>
          <div className="text-[12px] text-text-tertiary">{item.email}</div>
        </div>
      ),
    },
    { key: 'item', header: 'Item' },
    {
      key: 'amount',
      header: 'Amount',
      render: (item) => <span className="font-medium">{fmtUsd(item.amount)}</span>,
    },
    { key: 'method', header: 'Method' },
    {
      key: 'riskScore',
      header: 'Risk',
      render: (item) => (
        <span className={`text-[12px] font-semibold ${
          Number(item.riskScore || 0) >= 80 ? 'text-danger' :
          Number(item.riskScore || 0) >= 50 ? 'text-warning' :
          'text-text-tertiary'
        }`}>
          {Number(item.riskScore || 0)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (item) => <StatusBadge status={item.status} color={statusColors[item.status] || 'gray'} />,
    },
    {
      key: 'date',
      header: 'Date',
      render: (item) => fmtDate(item.date),
    },
    {
      key: 'actions' as keyof Payment,
      header: '',
      render: (item) => (
        <div className="flex justify-end gap-2">
          <button className="text-[12px] font-medium text-accent hover:text-accent-hover transition-colors">
            View
          </button>
          <button
            className="text-[12px] font-medium text-text-tertiary hover:text-text-primary transition-colors mr-2"
            onClick={() => openAudit(item)}
          >
            Audit
          </button>
          {item.status === 'completed' && (
            <button
              className="text-[12px] font-medium text-text-tertiary hover:text-text-primary transition-colors"
              onClick={() => { setSelectedPayment(item); setIsRefundModalOpen(true); }}
            >
              Refund
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="space-y-5">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Payments</h1>
          <p className="text-[13px] text-text-tertiary mt-0.5">
            Track all platform transactions, subscriptions, and coin purchases.
          </p>
        </div>
        <div className="flex gap-2">
          <ActionButton variant="ghost" icon={RefreshCwIcon} onClick={load} isLoading={loading}>
            Refresh
          </ActionButton>
          <ActionButton variant="secondary" icon={DownloadIcon}>Export Records</ActionButton>
        </div>
      </div>

      {error && (
        <div className="bg-danger/10 border border-danger/20 rounded-lg p-4 text-danger text-[13px]">
          {error}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {(['payments', 'fraud', 'webhooks', 'reconciliation'] as PaymentsTab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`px-3 py-1.5 rounded-lg text-[12px] font-medium capitalize ${
              activeTab === tab ? 'bg-accent text-white' : 'bg-bg-elevated text-text-secondary'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-4">
        <StatsCard
          title="Total Transactions"
          value={stats ? stats.totalTransactions.toLocaleString() : '…'}
          icon={CreditCardIcon}
        />
        <StatsCard
          title="Total Revenue"
          value={stats ? fmtUsd(stats.totalRevenue) : '…'}
          icon={DollarSignIcon}
        />
        <StatsCard title="Pending" value={stats ? String(stats.pending) : '…'} icon={RefreshCcwIcon} />
        <StatsCard title="Failed" value={stats ? String(stats.failed) : '…'} icon={AlertCircleIcon} />
        <StatsCard title="Refunded" value={stats ? fmtUsd(stats.refunded) : '…'} icon={RefreshCcwIcon} />
        <StatsCard title="Fraud Alerts" value={stats ? String(stats.fraudAlerts || 0) : '…'} icon={AlertCircleIcon} />
      </div>

      {activeTab === 'fraud' && (
        <div className="card overflow-hidden p-4">
          {loading ? <p className="text-text-tertiary text-[13px]">Loading…</p> : (
            <div className="space-y-2">
              {fraudAlerts.map((a) => (
                <div key={a.id} className="p-3 rounded-lg bg-bg-elevated text-[13px]">
                  <div className="font-medium text-text-primary">{a.reason}</div>
                  <div className="text-text-tertiary mt-1">Score {a.risk_score} · {a.provider || 'n/a'} · {a.status}</div>
                </div>
              ))}
              {!fraudAlerts.length && <p className="text-text-tertiary">No open fraud alerts.</p>}
            </div>
          )}
        </div>
      )}

      {activeTab === 'webhooks' && (
        <div className="card overflow-hidden p-4">
          {loading ? <p className="text-text-tertiary text-[13px]">Loading…</p> : (
            <div className="space-y-2 max-h-[480px] overflow-y-auto">
              {webhookEvents.map((e) => (
                <div key={e.id} className="p-3 rounded-lg bg-bg-elevated text-[12px] font-mono">
                  <div>{e.provider} · {e.event_type} · {e.status}</div>
                  <div className="text-text-tertiary mt-1">{e.provider_reference || e.replay_key}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'reconciliation' && reconciliation && (
        <div className="card p-4 text-[13px] space-y-2">
          <p>Fulfilled intents: {String(reconciliation.fulfilledCount)}</p>
          <p>Transactions logged: {String(reconciliation.transactionsCount)}</p>
          <p>Orphan fulfillments: {Array.isArray(reconciliation.orphanFulfillments) ? reconciliation.orphanFulfillments.length : 0}</p>
          <p>Open fraud alerts: {String(reconciliation.openFraudAlerts)}</p>
        </div>
      )}

      {activeTab === 'payments' && (
      <div className="card overflow-hidden">
        <div className="p-4 border-b border-border-default">
          <FilterBar
            searchValue={search}
            onSearchChange={(v) => { setSearch(v); setCurrentPage(1); }}
            searchPlaceholder="Search by name, email, or reference..."
            filters={[
              {
                label: 'Status',
                value: statusFilter,
                onChange: (v) => { setStatusFilter(v); setCurrentPage(1); },
                options: [
                  { label: 'All Statuses', value: '' },
                  { label: 'Active', value: 'active' },
                  { label: 'Expired', value: 'expired' },
                  { label: 'Cancelled', value: 'cancelled' },
                  { label: 'Pending', value: 'pending' },
                  { label: 'Checkout Created', value: 'checkout_created' },
                  { label: 'Fulfilled', value: 'fulfilled' },
                  { label: 'Suspicious', value: 'suspicious' },
                  { label: 'Failed', value: 'failed' },
                ],
              },
              {
                label: 'Method',
                value: methodFilter,
                onChange: (v) => { setMethodFilter(v); setCurrentPage(1); },
                options: [
                  { label: 'All Methods', value: '' },
                  { label: 'Paystack', value: 'paystack' },
                  { label: 'Flutterwave', value: 'flutterwave' },
                  { label: 'Monnify (legacy)', value: 'monnify' },
                  { label: 'Stripe', value: 'stripe' },
                  { label: 'Flutterwave', value: 'flutterwave' },
                ],
              },
            ]}
          />
        </div>

        {loading ? (
          <div className="p-8 text-center text-text-tertiary text-[13px]">Loading payments…</div>
        ) : (
          <DataTable columns={columns} data={payments} keyExtractor={(item) => item.id} />
        )}

        <Pagination
          currentPage={currentPage}
          totalPages={Math.max(1, Math.ceil(total / itemsPerPage))}
          totalItems={total}
          itemsPerPage={itemsPerPage}
          onPageChange={setCurrentPage}
          onItemsPerPageChange={(items) => { setItemsPerPage(items); setCurrentPage(1); }}
        />
      </div>
      )}

      <Modal
        isOpen={auditOpen}
        onClose={() => setAuditOpen(false)}
        title="Payment audit trail"
        footer={<ActionButton variant="ghost" onClick={() => setAuditOpen(false)}>Close</ActionButton>}
      >
        {auditData ? (
          <div className="space-y-3 text-[12px] max-h-[400px] overflow-y-auto">
            <pre className="bg-bg-elevated p-2 rounded overflow-x-auto">{JSON.stringify(auditData.intent, null, 2)}</pre>
            {auditData.auditLogs.map((log) => (
              <div key={String(log.id)} className="border-l-2 border-accent pl-2">
                <div className="font-medium">{String(log.event_type)}</div>
                <div className="text-text-tertiary">{String(log.message)}</div>
              </div>
            ))}
          </div>
        ) : null}
      </Modal>

      <Modal
        isOpen={isRefundModalOpen}
        onClose={() => setIsRefundModalOpen(false)}
        title="Refund Payment"
        footer={
          <>
            <ActionButton variant="ghost" onClick={() => setIsRefundModalOpen(false)}>Cancel</ActionButton>
            <ActionButton variant="primary" onClick={() => setIsRefundModalOpen(false)}>Process Refund</ActionButton>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-[13px] text-text-secondary">
            Are you sure you want to refund{' '}
            <strong className="text-text-primary">{selectedPayment ? fmtUsd(selectedPayment.amount) : ''}</strong> to{' '}
            <strong className="text-text-primary">{selectedPayment?.name}</strong>?
          </p>
          <div className="bg-bg-elevated p-3 rounded-lg text-[13px] space-y-2">
            <div className="flex justify-between">
              <span className="text-text-tertiary">Reference:</span>
              <span className="font-mono text-text-primary">{selectedPayment?.reference}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-tertiary">Item:</span>
              <span className="text-text-primary">{selectedPayment?.item}</span>
            </div>
          </div>
          <div>
            <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
              Reason for refund
            </label>
            <textarea className="input-field min-h-[100px]" placeholder="Enter reason..." />
          </div>
        </div>
      </Modal>
    </motion.div>
  );
}
