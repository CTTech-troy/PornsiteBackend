import { API_BASE, apiMessage, clearAdminSession, isAdminSessionFailure, readApiResponse } from './http';

function getToken(): string {
  return localStorage.getItem('admin_token') || '';
}

function authHeaders(): HeadersInit {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` };
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}/api/admin/system${path}`, {
    ...init,
    headers: { ...authHeaders(), ...init?.headers },
  });
  if (isAdminSessionFailure(res.status)) {
    clearAdminSession();
    window.location.href = '/login';
    throw new Error('Session expired. Please log in again.');
  }
  const data = await readApiResponse(res);
  if (!res.ok) throw new Error(apiMessage(data));
  return data as T;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PlatformSetting {
  key: string;
  value: string;
  label?: string;
  section?: string;
  type?: 'text' | 'email' | 'url' | 'number' | 'toggle' | 'select' | 'textarea' | 'json' | 'secret';
  defaultValue?: string;
  description?: string;
  options?: string[];
  required?: boolean;
  sensitive?: boolean;
  envKey?: string | null;
  envConfigured?: boolean;
  public?: boolean;
  updated_at?: string;
}

export interface SystemHealth {
  services: Record<string, { status: string; detail: string; active: boolean }>;
  stats: {
    totalUsers: number;
    userSourceCounts?: AdminStats['users']['sourceCounts'] | null;
    activeLives: number;
    activeSubscriptions: number;
    pendingPayouts: number;
  };
  runtime?: {
    memory?: {
      rss: number;
      heapUsed: number;
      heapTotal: number;
      external: number;
    };
    cpu?: { user: number; system: number };
    uptime?: number;
  };
  apiMetrics?: {
    startedAt: string;
    total: number;
    success: number;
    failure: number;
    avgLatencyMs: number;
    routes: Array<{
      path: string;
      count: number;
      success: number;
      failure: number;
      avgLatencyMs: number;
      maxLatencyMs: number;
      lastStatus: number;
      lastSeenAt: string | null;
    }>;
  } | null;
  timestamp: string;
}

export interface EnvVar {
  key: string;
  value: string;
  sensitive: boolean;
}

export interface EnvOverview {
  env: EnvVar[];
  nodeVersion: string;
  platform: string;
  uptime: number;
}

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: string;
  avatar_url?: string | null;
  permissions?: string[];
  is_active: boolean;
  is_super_admin: boolean;
  online?: boolean;
  account_status?: string;
  created_at: string;
  last_login: string | null;
  last_active_at?: string | null;
}

// ── Stats ─────────────────────────────────────────────────────────────────────

export interface AdminStats {
  users:       {
    total: number;
    totalIncludingFirebase?: number;
    firebaseOnly?: number;
    verified?: number;
    active: number;
    newToday: number;
    suspended: number;
    banned?: number;
    sourceCounts?: {
      mergedTotal: number;
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
    } | null;
  };
  creators:    { total: number; pstars: number; channels: number; pendingApplications: number };
  content:     { videos: number; liveNow: number };
  memberships: { active: number };
  ads:         { activeCampaigns: number };
}

export function fetchAdminStats(): Promise<AdminStats> {
  return apiFetch('/stats');
}

// ── Settings ──────────────────────────────────────────────────────────────────

export function fetchSettings(): Promise<{ settings: PlatformSetting[] }> {
  return apiFetch('/settings');
}

export function saveSettings(settings: { key: string; value: string }[]): Promise<{ message: string }> {
  return apiFetch('/settings', { method: 'PUT', body: JSON.stringify({ settings }) });
}

export function saveSetting(key: string, value: string): Promise<{ message: string }> {
  return apiFetch(`/settings/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify({ value }) });
}

// ── Health & Env ──────────────────────────────────────────────────────────────

export function fetchSystemHealth(): Promise<SystemHealth> {
  return apiFetch('/health');
}

export function fetchEnvOverview(): Promise<EnvOverview> {
  return apiFetch('/env');
}

// ── Admin Users ───────────────────────────────────────────────────────────────

export function fetchAdminUsers(): Promise<{ admins: AdminUser[] }> {
  return apiFetch('/admin-users');
}

export function toggleAdminUser(id: string, is_active: boolean): Promise<{ message: string }> {
  return apiFetch(`/admin-users/${id}/toggle`, { method: 'PUT', body: JSON.stringify({ is_active }) });
}

// ── API Health ────────────────────────────────────────────────────────────────

export interface ApiCheck {
  name: string;
  status: 'ok' | 'error';
  latencyMs: number;
  error?: string;
}

export interface ApiHealthResult {
  apis: ApiCheck[];
  totalMs: number;
  timestamp: string;
}

export function fetchApiHealth(): Promise<ApiHealthResult> {
  return apiFetch('/api-health');
}

// ── Route Latency ─────────────────────────────────────────────────────────────

export interface RouteLatencyResult {
  path: string;
  group: string;
  httpStatus: number;
  latencyMs: number;
  ok: boolean;
  error?: string;
}

export interface RouteLatencyReport {
  routes: RouteLatencyResult[];
  totalMs: number;
  timestamp: string;
}

export function fetchRouteLatency(): Promise<RouteLatencyReport> {
  return apiFetch('/route-latency');
}

// Production API observability
export type ApiMonitorStatus = 'healthy' | 'warning' | 'critical' | 'offline';

export interface ObservedApi {
  apiName: string;
  routeKey: string;
  routeGroup: string;
  method: string;
  endpoint: string;
  status: ApiMonitorStatus;
  uptimePct: number;
  healthScore: number;
  latencyMs: number;
  avgResponseTimeMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  maxLatencyMs: number;
  totalRequests: number;
  reads: number;
  writes: number;
  failedRequests: number;
  successRequests: number;
  errorRatePct: number;
  lastStatusCode: number;
  lastCheckedAt: string | null;
}

export interface ObservabilityOverview {
  success: boolean;
  range: string;
  source: string;
  timestamp: string;
  summary: {
    status: ApiMonitorStatus;
    healthScore: number;
    uptimePct: number;
    avgResponseTimeMs: number;
    errorRatePct: number;
    totalRequests: number;
    reads: number;
    writes: number;
    failedRequests: number;
    apiCount: number;
  };
  systemLoad: {
    uptimeSeconds: number;
    memory: {
      rss: number;
      heapUsed: number;
      heapTotal: number;
      external: number;
    };
    cpu: { user: number; system: number };
    loadAverage: number[];
  };
  ingestion: Record<string, unknown>;
  apis: ObservedApi[];
}

export interface ApiSeriesPoint {
  timestamp: string;
  requests: number;
  reads: number;
  writes: number;
  failures: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  successRatePct: number;
}

export interface ApiDistributionPoint {
  label: string;
  count: number;
}

export interface ApiHeatmapPoint {
  day: string;
  dayIndex: number;
  hour: number;
  requests: number;
  failures: number;
}

export interface ApiLogEntry {
  requestId: string;
  apiName: string;
  routeKey: string;
  routeGroup: string;
  method: string;
  endpoint: string;
  statusCode: number;
  success: boolean;
  latencyMs: number;
  requestBytes: number;
  responseBytes: number;
  operationType: 'read' | 'write' | 'other';
  ipHash: string;
  userAgent: string;
  adminId: string | null;
  userId: string | null;
  errorMessage: string | null;
  timestamp: string;
}

export interface ApiIncident {
  id: string;
  route_key: string;
  api_name: string;
  status: string;
  severity: string;
  reason: string;
  started_at: string;
  resolved_at: string | null;
  last_seen_at: string;
  sample?: ObservedApi;
}

export interface ObservedApiDetail {
  success: boolean;
  range: string;
  timestamp: string;
  api: ObservedApi;
  series: ApiSeriesPoint[];
  responseDistribution: ApiDistributionPoint[];
  activityHeatmap: ApiHeatmapPoint[];
  recentFailures: ApiLogEntry[];
  slowestEndpoints: ApiLogEntry[];
  requestLogs: {
    logs: ApiLogEntry[];
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  incidents: ApiIncident[];
}

export function fetchObservabilityOverview(range = '24h'): Promise<ObservabilityOverview> {
  return apiFetch(`/observability/overview?range=${encodeURIComponent(range)}`);
}

export function fetchObservedApis(range = '24h'): Promise<{ success: boolean; range: string; timestamp: string; apis: ObservedApi[] }> {
  return apiFetch(`/observability/apis?range=${encodeURIComponent(range)}`);
}

export function fetchObservedApiDetail(routeKey: string, range = '24h', page = 1, pageSize = 25): Promise<ObservedApiDetail> {
  const params = new URLSearchParams({ range, page: String(page), pageSize: String(pageSize) });
  return apiFetch(`/observability/apis/${encodeURIComponent(routeKey)}?${params.toString()}`);
}

export function fetchObservedRequestLogs(params: {
  routeKey?: string;
  page?: number;
  pageSize?: number;
  status?: 'failed' | 'server_error';
} = {}): Promise<ObservedApiDetail['requestLogs'] & { success: boolean }> {
  const search = new URLSearchParams();
  if (params.routeKey) search.set('routeKey', params.routeKey);
  if (params.page) search.set('page', String(params.page));
  if (params.pageSize) search.set('pageSize', String(params.pageSize));
  if (params.status) search.set('status', params.status);
  return apiFetch(`/observability/logs?${search.toString()}`);
}

export function triggerObservabilityAggregation(): Promise<{ success: boolean; timestamp: string }> {
  return apiFetch('/observability/aggregate', {
    method: 'POST',
    body: JSON.stringify({ rangeMinutes: 10, bucketMinutes: 1 }),
  });
}
