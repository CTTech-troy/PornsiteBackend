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
  const res = await fetch(`${API_BASE}/api/admin/content-removal${path}`, {
    ...init,
    headers: { ...authHeaders(), ...init?.headers },
  });
  if (res.status === 401) {
    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_user');
    window.location.href = '/login';
    throw new Error('Session expired. Please log in again.');
  }
  const data = await readApiResponse(res).catch((error) => {
    if (!res.ok) return {};
    throw error;
  });
  if (!res.ok) throw new Error(apiMessage(data, `Request failed (${res.status})`));
  return data as T;
}

export type ContentRemovalStatus = 'pending' | 'under_review' | 'approved' | 'rejected' | 'needs_info';

export interface ContentRemovalFile {
  name?: string;
  originalName?: string;
  mimeType?: string;
  size?: number;
  bucket?: string;
  path?: string;
  signedUrl?: string | null;
  uploadedAt?: string;
}

export interface ContentRemovalActivity {
  id?: string;
  type?: string;
  actor?: string;
  message?: string;
  at?: string;
  status?: string;
}

export interface ContentRemovalRequest {
  id: string;
  request_id: string;
  full_name: string;
  email: string;
  company?: string | null;
  phone?: string | null;
  relationship_to_content?: string | null;
  content_url: string;
  additional_urls?: string[];
  content_title?: string | null;
  reason: string;
  notes: string;
  evidence_notes?: string | null;
  files?: ContentRemovalFile[];
  status: ContentRemovalStatus;
  status_label?: string;
  admin_notes?: string | null;
  feedback_message?: string | null;
  consent_accuracy?: boolean;
  consent_authorized?: boolean;
  digital_signature?: string | null;
  activity?: ContentRemovalActivity[];
  submitted_at?: string;
  review_started_at?: string | null;
  decision_at?: string | null;
  deadline_at?: string | null;
  updated_at?: string;
  overdue?: boolean;
}

export interface ContentRemovalListResponse {
  success: boolean;
  count: number;
  page: number;
  limit: number;
  data: ContentRemovalRequest[];
}

export function fetchContentRemovalRequests(params: {
  status?: string;
  search?: string;
  page?: number;
  limit?: number;
} = {}): Promise<ContentRemovalListResponse> {
  const qs = new URLSearchParams();
  if (params.status && params.status !== 'all') qs.set('status', params.status);
  if (params.search) qs.set('search', params.search);
  qs.set('page', String(params.page || 1));
  qs.set('limit', String(params.limit || 50));
  return apiFetch<ContentRemovalListResponse>(`/?${qs.toString()}`);
}

export function updateContentRemovalRequest(id: string, payload: Partial<ContentRemovalRequest>): Promise<{ data: ContentRemovalRequest }> {
  return apiFetch<{ data: ContentRemovalRequest }>(`/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function updateContentRemovalStatus(id: string, status: ContentRemovalStatus, message = ''): Promise<{ data: ContentRemovalRequest }> {
  return apiFetch<{ data: ContentRemovalRequest }>(`/${encodeURIComponent(id)}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status, message }),
  });
}

export function sendContentRemovalFeedback(id: string, message: string): Promise<{ data: ContentRemovalRequest }> {
  return apiFetch<{ data: ContentRemovalRequest }>(`/${encodeURIComponent(id)}/feedback`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
}

export function subscribeContentRemovalEvents(onChange: () => void, onConnectionChange?: (connected: boolean) => void): () => void {
  return subscribeAdminEventStream('/api/content-removal/events', {
    'content-removal:created': onChange,
    'content-removal:updated': onChange,
    'content-removal:deleted': onChange,
  }, onConnectionChange);
}
