import { API_BASE, apiMessage, readApiResponse, subscribeAdminEventStream } from './http';

function getToken(): string {
  return localStorage.getItem('admin_token') || '';
}

function authHeaders(): HeadersInit {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${getToken()}`,
  };
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}/api/admin/finance${path}`, {
    ...init,
    headers: { ...authHeaders(), ...init?.headers },
  });
  if (res.status === 401) {
    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_user');
    window.location.href = '/login';
    throw new Error('Session expired. Please log in again.');
  }
  const data = await readApiResponse(res);
  if (!res.ok) throw new Error(apiMessage(data, 'Request failed'));
  return data as T;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface FinanceSummary {
  totalRevenue: number;
  pendingPayouts: number;
  liveGiftRevenue: number;
  adRevenue: number;
  recentTransactions: RecentTransaction[];
  payoutLogs?: FinancePayoutLog[];
}

export interface RecentTransaction {
  id: string;
  type: string;
  userId: string;
  userName: string | null;
  planId: string;
  amount: number;
  method: string;
  status: string;
  date: string;
}

export interface FinancePayoutLog {
  id: string;
  payout_request_id?: string;
  creator_id: string;
  creator_name?: string | null;
  amount_usd: number;
  amount_ngn?: number | null;
  transaction_reference?: string | null;
  payout_status: string;
  payment_date?: string | null;
  provider?: string | null;
  error_message?: string | null;
  created_at?: string;
}

export interface MembershipPlan {
  id: string;
  name: string;
  description: string;
  price_usd: number;
  price_ngn: number;
  coins: number;
  duration_days: number;
  is_active: boolean;
  activeSubscribers: number;
  expiredSubscribers: number;
  revenue: number;
}

export interface Subscriber {
  id: string;
  userId: string;
  name: string;
  email: string;
  planId: string;
  planName: string;
  amount: number;
  paymentMethod: string;
  status: string;
  startDate: string;
  expiryDate: string;
}

export interface Payment {
  id: string;
  reference: string;
  userId: string;
  name: string;
  email: string;
  item: string;
  amount: number;
  method: string;
  status: string;
  date: string;
  riskScore?: number;
  riskFlags?: string[];
}

export interface PaymentStats {
  totalTransactions: number;
  totalRevenue: number;
  pending: number;
  failed: number;
  refunded: number;
  fraudAlerts?: number;
  tokenSales?: number;
  conversionRate?: number;
}

export interface CreatorPayout {
  id: string;
  creator_id: string;
  creator_name: string;
  creator_email: string;
  channel_name: string;
  amount_usd: number;
  amount_ngn?: number;
  bank_name?: string;
  bank_code?: string;
  account_number?: string;
  account_name?: string;
  reference_id?: string;
  paystack_transaction_reference?: string;
  paystack_transfer_code?: string;
  paid_at?: string;
  failure_reason?: string;
  transaction_reference?: string;
  proof_url?: string;
  approved_at?: string;
  finance_assigned_at?: string;
  finance_assignee_id?: string;
  admin_notes?: string;
  internal_notes?: string;
  risk_score?: number;
  risk_flags?: string[];
  completed_at?: string;
  estimated_processing_time?: string;
  method: string;
  status: string;
  rejection_reason?: string;
  requested_at: string;
  processed_at?: string;
}

export interface PayoutStats {
  pendingTotal: number;
  approvedTotal?: number;
  processingTotal?: number;
  completedTotal?: number;
  failedTotal?: number;
  processedThisMonth: number;
  totalCreatorBalances: number;
  avgPayout: number;
  highRiskCount?: number;
}

export interface PayoutAnalytics {
  totalPayouts: number;
  pendingPayouts: number;
  approvedPayouts: number;
  processingPayouts: number;
  completedPayouts: number;
  failedPayouts: number;
  rejectedPayouts: number;
  highRiskCount: number;
  completedThisMonth: number;
  avgProcessingHours: number;
  daily: Array<{ date: string; amount: number }>;
}

export type AdPlacement = 'homepage_banner' | 'sidebar' | 'video_player' | 'creator_profile' | 'feed';

export interface AdCampaign {
  id: string;
  name: string;
  description?: string;
  budget_usd: number;
  cpc: number;
  impressions: number;
  clicks: number;
  revenue_usd: number;
  status: 'active' | 'paused' | 'ended';
  is_active: boolean;
  start_date?: string;
  end_date?: string;
  image_url?: string;
  redirect_url?: string;
  cta_text?: string;
  placement?: AdPlacement;
  image_width?: number;
  image_height?: number;
  created_at: string;
}

export interface AdStats {
  activeCampaigns: number;
  totalImpressions: number;
  adRevenue: number;
}

export interface AdImageUploadResult {
  url: string;
  width: number;
  height: number;
}

// ── Finance Summary ──────────────────────────────────────────────────────────

export function fetchFinanceSummary(): Promise<FinanceSummary> {
  return apiFetch<FinanceSummary>('/summary');
}

export function subscribeFinanceEvents(onChange: () => void, onConnectionChange?: (connected: boolean) => void): () => void {
  return subscribeAdminEventStream('/api/admin/finance/events', {
    'finance:payout-created': onChange,
    'finance:payout-updated': onChange,
  }, onConnectionChange);
}

// ── Membership Plans ─────────────────────────────────────────────────────────

export function fetchMembershipPlans(): Promise<{ plans: MembershipPlan[] }> {
  return apiFetch<{ plans: MembershipPlan[] }>('/membership-plans');
}

export function createMembershipPlan(payload: {
  name: string; description?: string; price_usd: number; price_ngn?: number; coins: number; duration_days: number;
}): Promise<{ plan: MembershipPlan }> {
  return apiFetch<{ plan: MembershipPlan }>('/membership-plans', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function toggleMembershipPlan(id: string, is_active: boolean): Promise<{ plan: MembershipPlan }> {
  return apiFetch<{ plan: MembershipPlan }>(`/membership-plans/${id}/toggle`, {
    method: 'PUT',
    body: JSON.stringify({ is_active }),
  });
}

export function deleteMembershipPlan(id: string): Promise<{ message: string }> {
  return apiFetch<{ message: string }>(`/membership-plans/${id}`, { method: 'DELETE' });
}

// ── Subscribers ──────────────────────────────────────────────────────────────

export function fetchSubscribers(params: {
  page?: number; limit?: number; search?: string; planFilter?: string; statusFilter?: string;
}): Promise<{ subscribers: Subscriber[]; total: number; page: number; limit: number }> {
  const q = new URLSearchParams();
  if (params.page)         q.set('page',         String(params.page));
  if (params.limit)        q.set('limit',        String(params.limit));
  if (params.search)       q.set('search',       params.search);
  if (params.planFilter)   q.set('planFilter',   params.planFilter);
  if (params.statusFilter) q.set('statusFilter', params.statusFilter);
  return apiFetch(`/subscribers?${q}`);
}

// ── Payments ─────────────────────────────────────────────────────────────────

export interface FraudAlert {
  id: string;
  user_id?: string;
  intent_id?: string;
  provider?: string;
  provider_reference?: string;
  risk_score: number;
  risk_flags?: string[];
  reason: string;
  status: string;
  created_at: string;
}

export interface WebhookEvent {
  id: string;
  provider: string;
  event_type: string;
  provider_reference?: string;
  signature_valid: boolean;
  replay_key: string;
  status: string;
  received_at: string;
  processed_at?: string;
  error_message?: string;
}

export function fetchFraudAlerts(params: {
  page?: number; limit?: number; status?: string;
} = {}): Promise<{ alerts: FraudAlert[]; total: number; page: number; limit: number }> {
  const q = new URLSearchParams();
  if (params.page) q.set('page', String(params.page));
  if (params.limit) q.set('limit', String(params.limit));
  if (params.status) q.set('status', params.status);
  return apiFetch(`/fraud-alerts?${q}`);
}

export function fetchWebhookEvents(params: {
  page?: number; limit?: number; provider?: string; status?: string;
} = {}): Promise<{ events: WebhookEvent[]; total: number; page: number; limit: number }> {
  const q = new URLSearchParams();
  if (params.page) q.set('page', String(params.page));
  if (params.limit) q.set('limit', String(params.limit));
  if (params.provider) q.set('provider', params.provider);
  if (params.status) q.set('status', params.status);
  return apiFetch(`/webhook-events?${q}`);
}

export function fetchPaymentAudit(intentId: string): Promise<{
  intent: Record<string, unknown>;
  auditLogs: Array<Record<string, unknown>>;
  transactions: Array<Record<string, unknown>>;
}> {
  return apiFetch(`/payment-intents/${intentId}/audit`);
}

export function fetchPaymentReconciliation(hours = 24): Promise<Record<string, unknown>> {
  return apiFetch(`/reconciliation?hours=${hours}`);
}

export function fetchPayments(params: {
  page?: number; limit?: number; search?: string; statusFilter?: string; methodFilter?: string;
}): Promise<{ payments: Payment[]; total: number; page: number; limit: number; stats: PaymentStats }> {
  const q = new URLSearchParams();
  if (params.page)         q.set('page',         String(params.page));
  if (params.limit)        q.set('limit',        String(params.limit));
  if (params.search)       q.set('search',       params.search);
  if (params.statusFilter) q.set('statusFilter', params.statusFilter);
  if (params.methodFilter) q.set('methodFilter', params.methodFilter);
  return apiFetch(`/payments?${q}`);
}

// ── Creator Payouts ──────────────────────────────────────────────────────────

export function fetchCreatorPayouts(params: {
  page?: number; limit?: number; search?: string; statusFilter?: string; methodFilter?: string;
}): Promise<{ payouts: CreatorPayout[]; total: number; page: number; limit: number; stats: PayoutStats }> {
  const q = new URLSearchParams();
  if (params.page)         q.set('page',         String(params.page));
  if (params.limit)        q.set('limit',        String(params.limit));
  if (params.search)       q.set('search',       params.search);
  if (params.statusFilter) q.set('statusFilter', params.statusFilter);
  if (params.methodFilter) q.set('methodFilter', params.methodFilter);
  return apiFetch(`/payouts?${q}`);
}

export function approveCreatorPayout(id: string, body: { notes?: string; financeAssigneeId?: string } = {}): Promise<{ message: string; payout?: CreatorPayout }> {
  return apiFetch(`/payouts/${id}/approve`, { method: 'POST', body: JSON.stringify(body) });
}

export function markPayoutProcessing(id: string, body: { transactionReference?: string; notes?: string } = {}): Promise<{ message: string; payout?: CreatorPayout }> {
  return apiFetch(`/payouts/${id}/mark-processing`, { method: 'POST', body: JSON.stringify(body) });
}

export function markPayoutPaid(id: string, body: {
  transactionReference?: string;
  proofUrl?: string;
  provider?: string;
  notes?: string;
  useGateway?: boolean;
} = {}): Promise<{ message: string; payout?: CreatorPayout }> {
  return apiFetch(`/payouts/${id}/mark-paid`, { method: 'POST', body: JSON.stringify(body) });
}

export function markPayoutFailed(id: string, reason: string): Promise<{ message: string; payout?: CreatorPayout }> {
  return apiFetch(`/payouts/${id}/mark-failed`, { method: 'POST', body: JSON.stringify({ reason }) });
}

export function retryPayout(id: string): Promise<{ message: string; payout?: CreatorPayout }> {
  return apiFetch(`/payouts/${id}/retry`, { method: 'POST' });
}

export function rejectCreatorPayout(id: string, reason: string): Promise<{ message: string }> {
  return apiFetch(`/payouts/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
}

export function fetchPayoutAnalytics(): Promise<{ analytics: PayoutAnalytics }> {
  return apiFetch('/payouts/analytics');
}

export function payoutExportUrl(): string {
  return `${API_BASE}/api/admin/finance/payouts/export.csv`;
}

export async function uploadPayoutProof(id: string, file: File, body: { transactionReference?: string; provider?: string; notes?: string } = {}): Promise<{ message: string; proofUrl: string; payout?: CreatorPayout }> {
  const token = getToken();
  const form = new FormData();
  form.append('proof', file);
  Object.entries(body).forEach(([key, value]) => {
    if (value) form.append(key, value);
  });

  const res = await fetch(`${API_BASE}/api/admin/finance/payouts/${id}/proof`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  const data = await readApiResponse(res);
  if (!res.ok) throw new Error(apiMessage(data, 'Proof upload failed'));
  return data as { message: string; proofUrl: string; payout?: CreatorPayout };
}

// ── Ad Campaigns ─────────────────────────────────────────────────────────────

export function fetchAdCampaigns(): Promise<{ campaigns: AdCampaign[]; stats: AdStats }> {
  return apiFetch('/ads');
}

export function createAdCampaign(payload: Omit<Partial<AdCampaign>, 'id' | 'impressions' | 'clicks' | 'revenue_usd' | 'created_at'> & { name: string }): Promise<{ campaign: AdCampaign }> {
  return apiFetch('/ads', { method: 'POST', body: JSON.stringify(payload) });
}

export function updateAdCampaign(id: string, payload: Partial<AdCampaign>): Promise<{ campaign: AdCampaign }> {
  return apiFetch(`/ads/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
}

export function deleteAdCampaign(id: string): Promise<{ message: string }> {
  return apiFetch(`/ads/${id}`, { method: 'DELETE' });
}

/** Upload an ad image; returns the stored URL + detected dimensions. */
export async function uploadAdImage(file: File): Promise<AdImageUploadResult> {
  const token = getToken();
  const form = new FormData();
  form.append('image', file);

  const res = await fetch(`${API_BASE}/api/admin/finance/ads/upload-image`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  if (res.status === 401) {
    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_user');
    window.location.href = '/login';
    throw new Error('Session expired.');
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Image upload failed');
  return data as AdImageUploadResult;
}
