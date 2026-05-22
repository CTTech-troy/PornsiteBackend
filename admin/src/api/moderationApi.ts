import { API_BASE, apiMessage, readApiResponse, subscribeAdminEventStream } from './http';
import { io, type Socket } from 'socket.io-client';

function getToken(): string {
  return localStorage.getItem('admin_token') || '';
}

function authHeaders(): HeadersInit {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` };
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}/api/admin/moderation${path}`, {
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

export interface AuditLog {
  id: string;
  admin_id: string | null;
  admin_name: string;
  admin_email?: string | null;
  action: string;
  action_type?: string;
  target_type: string;
  target_id: string;
  resource?: string | null;
  details: Record<string, unknown>;
  status: string;
  severity?: 'info' | 'warning' | 'error' | 'critical' | string;
  ip_address?: string | null;
  user_agent?: string | null;
  device?: string | null;
  created_at: string;
}

export interface AIFlag {
  id: string;
  content_id: string;
  content_type: string;
  reason: string;
  severity: string;
  status: string;
  review_note: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  created_at: string;
}

export function fetchAuditLogs(params: {
  page?: number;
  limit?: number;
  search?: string;
  actionFilter?: string;
  adminFilter?: string;
  severityFilter?: string;
  statusFilter?: string;
  fromDate?: string;
  toDate?: string;
}): Promise<{ logs: AuditLog[]; total: number; page: number; limit: number }> {
  const q = new URLSearchParams();
  if (params.page) q.set('page', String(params.page));
  if (params.limit) q.set('limit', String(params.limit));
  if (params.search) q.set('search', params.search);
  if (params.actionFilter) q.set('actionFilter', params.actionFilter);
  if (params.adminFilter) q.set('adminFilter', params.adminFilter);
  if (params.severityFilter) q.set('severityFilter', params.severityFilter);
  if (params.statusFilter) q.set('statusFilter', params.statusFilter);
  if (params.fromDate) q.set('fromDate', params.fromDate);
  if (params.toDate) q.set('toDate', params.toDate);
  return apiFetch(`/audit-logs?${q}`);
}

export function subscribeAuditLogEvents(
  onCreated: (log: AuditLog) => void,
  onConnectionChange?: (connected: boolean) => void,
): () => void {
  return subscribeAdminEventStream('/api/admin/moderation/audit-logs/events', {
    'audit-log:created': (payload) => onCreated(payload as AuditLog),
  }, onConnectionChange);
}

export function fetchAIFlags(params: {
  page?: number;
  limit?: number;
  search?: string;
  statusFilter?: string;
  severityFilter?: string;
}): Promise<{ flags: AIFlag[]; total: number; page: number; limit: number }> {
  const q = new URLSearchParams();
  if (params.page) q.set('page', String(params.page));
  if (params.limit) q.set('limit', String(params.limit));
  if (params.search) q.set('search', params.search);
  if (params.statusFilter) q.set('statusFilter', params.statusFilter);
  if (params.severityFilter) q.set('severityFilter', params.severityFilter);
  return apiFetch(`/ai-flags?${q}`);
}

export function updateAIFlag(id: string, status: string, reviewNote?: string): Promise<{ message: string }> {
  return apiFetch(`/ai-flags/${id}`, { method: 'PUT', body: JSON.stringify({ status, reviewNote }) });
}

export interface AiSession {
  id: string;
  session_id: string;
  session_type: 'livestream' | 'ivi' | 'upload' | 'chat' | 'behavior' | 'finance' | 'system' | string;
  status: string;
  title?: string | null;
  creator_id?: string | null;
  risk_score: number;
  max_risk_score: number;
  event_count: number;
  alert_count: number;
  last_event_at?: string | null;
  started_at: string;
  ended_at?: string | null;
  metadata?: Record<string, unknown>;
  hiddenParticipant?: { id: string; role: string; hidden: boolean };
}

export interface ModerationEvent {
  id: string;
  session_id: string;
  session_type?: string;
  event_type: string;
  source: string;
  user_id?: string | null;
  peer_user_id?: string | null;
  content_type?: string | null;
  message?: string | null;
  transcript?: string | null;
  risk_score: number;
  confidence: number;
  severity: string;
  verdict: string;
  model_name?: string | null;
  labels?: Record<string, unknown>;
  created_at: string;
}

export interface AiAlert {
  id: string;
  session_id: string;
  alert_type: string;
  severity: string;
  status: string;
  title: string;
  description?: string | null;
  risk_score: number;
  assigned_to?: string | null;
  escalated_at?: string | null;
  created_at: string;
  updated_at?: string;
}

export interface AiWorkerHealth {
  worker_id: string;
  worker_type: string;
  status: string;
  model_name?: string | null;
  gpu_name?: string | null;
  gpu_memory_used_mb?: number | null;
  gpu_memory_total_mb?: number | null;
  queue_depth: number;
  inference_latency_ms: number;
  throughput_per_minute: number;
  last_heartbeat_at: string;
  metadata?: Record<string, unknown>;
}

export interface AiOverview {
  stats: {
    activeSessions: number;
    flaggedSessions: number;
    realtimeAlerts: number;
    criticalAlerts: number;
    eventsLastHour: number;
    avgRiskScore: number;
  };
  aiHealth: {
    status: string;
    workersOnline: number;
    workersTotal?: number;
    avgLatencyMs: number;
  };
  sessions: AiSession[];
  alerts: AiAlert[];
  feed: ModerationEvent[];
  redis: Record<string, unknown>;
  qstash: Record<string, unknown>;
}

export interface AiAnalytics {
  timeline: Array<{ ts: string; events: number; avgRisk: number; critical: number }>;
  byType: Array<{ type: string; events: number; avgRisk: number }>;
  confidence: Array<{ ts: string; confidence: number; risk: number }>;
  heatmap: Array<{ day: number; hour: number; count: number }>;
}

export interface AiRule {
  id: string;
  rule_key: string;
  label: string;
  category: string;
  value: Record<string, unknown>;
  enabled: boolean;
  updated_at: string;
}

export interface AiTrainingLog {
  id: string;
  initiated_by?: string | null;
  dataset_name?: string | null;
  model_name: string;
  status: string;
  metrics?: Record<string, unknown>;
  created_at: string;
  completed_at?: string | null;
}

export interface AiFraudPayload {
  logs: Array<Record<string, any>>;
  suspiciousPayouts: Array<Record<string, any>>;
  profiles: Array<Record<string, any>>;
}

export function fetchAiOverview(): Promise<AiOverview> {
  return apiFetch('/ai/overview');
}

export function fetchAiLiveMonitoring(): Promise<{ sessions: AiSession[]; alerts: AiAlert[]; feed: ModerationEvent[] }> {
  return apiFetch('/ai/live');
}

export function fetchAiIncidents(params: {
  page?: number; limit?: number; status?: string; severity?: string; search?: string;
}): Promise<{ incidents: AiAlert[]; total: number; page: number; limit: number }> {
  const q = new URLSearchParams();
  if (params.page) q.set('page', String(params.page));
  if (params.limit) q.set('limit', String(params.limit));
  if (params.status) q.set('status', params.status);
  if (params.severity) q.set('severity', params.severity);
  if (params.search) q.set('search', params.search);
  return apiFetch(`/ai/incidents?${q}`);
}

export function fetchAiAnalytics(range = '24h'): Promise<AiAnalytics> {
  return apiFetch(`/ai/analytics?range=${encodeURIComponent(range)}`);
}

export function fetchAiFraud(): Promise<AiFraudPayload> {
  return apiFetch('/ai/fraud');
}

export function fetchAiTraining(): Promise<{ rules: AiRule[]; trainingLogs: AiTrainingLog[] }> {
  return apiFetch('/ai/training');
}

export function fetchAiInfrastructure(): Promise<{
  workers: AiWorkerHealth[];
  serviceHealth: Record<string, unknown>;
  aiHealth: Record<string, unknown>;
  redis: Record<string, unknown>;
  qstash: Record<string, unknown>;
  queues: Record<string, number>;
  recentAlertFeed: AiAlert[];
}> {
  return apiFetch('/ai/infrastructure');
}

export function fetchAiSessionDetail(sessionId: string): Promise<{
  session: AiSession;
  events: ModerationEvent[];
  alerts: AiAlert[];
  scores: Array<Record<string, any>>;
}> {
  return apiFetch(`/ai/sessions/${encodeURIComponent(sessionId)}`);
}

export function reviewAiAlert(id: string, body: { status: string; action?: string; notes?: string }): Promise<{ message: string; alert: AiAlert }> {
  return apiFetch(`/ai/alerts/${id}/review`, { method: 'POST', body: JSON.stringify(body) });
}

export function updateAiRule(ruleKey: string, body: { value: Record<string, unknown>; enabled?: boolean }): Promise<{ message: string; rule: AiRule }> {
  return apiFetch(`/ai/rules/${encodeURIComponent(ruleKey)}`, { method: 'PUT', body: JSON.stringify(body) });
}

export function triggerAiRetraining(body: { datasetName?: string; modelName?: string; thresholdConfig?: Record<string, unknown> }): Promise<{ message: string; log: AiTrainingLog }> {
  return apiFetch('/ai/training/retrain', { method: 'POST', body: JSON.stringify(body) });
}

export function subscribeAiModerationSocket(handlers: {
  onOverview?: (overview: AiOverview) => void;
  onSession?: (payload: { session: AiSession }) => void;
  onAlert?: (payload: { alert: AiAlert }) => void;
  onEvent?: (payload: { event: ModerationEvent; alert?: AiAlert | null }) => void;
  onError?: (message: string) => void;
}): () => void {
  const socketBase = API_BASE || window.location.origin;
  const socket: Socket = io(socketBase, {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    auth: { adminToken: getToken() },
  });

  socket.on('connect', () => socket.emit('admin:ai-moderation:subscribe', { token: getToken() }));
  socket.on('admin:ai-moderation:update', (payload) => handlers.onOverview?.(payload as AiOverview));
  socket.on('ai:session-updated', (payload) => handlers.onSession?.(payload as { session: AiSession }));
  socket.on('ai:alert-created', (payload) => handlers.onAlert?.(payload as { alert: AiAlert }));
  socket.on('ai:alert-updated', (payload) => handlers.onAlert?.(payload as { alert: AiAlert }));
  socket.on('ai:alert-escalated', (payload) => handlers.onAlert?.(payload as { alert: AiAlert }));
  socket.on('ai:event-created', (payload) => handlers.onEvent?.(payload as { event: ModerationEvent; alert?: AiAlert | null }));
  socket.on('ai:event-updated', (payload) => handlers.onEvent?.(payload as { event: ModerationEvent; alert?: AiAlert | null }));
  socket.on('admin:ai-moderation:error', (payload) => handlers.onError?.(payload?.message || 'AI moderation socket error'));

  return () => {
    socket.emit('admin:ai-moderation:unsubscribe');
    socket.disconnect();
  };
}
