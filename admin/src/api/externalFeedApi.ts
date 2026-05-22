import { API_BASE, apiMessage, readApiResponse } from './http';

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
  if (res.status === 401) {
    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_user');
    window.location.href = '/login';
    throw new Error('Session expired. Please log in again.');
  }
  const data = await readApiResponse(res);
  if (!res.ok) throw new Error(apiMessage(data));
  return data as T;
}

export type PeriodMode = 'current_month' | 'fixed' | 'none';

export interface ExternalFeedProvider {
  label: string;
  host: string;
  apiKey: string;
  hasApiKey?: boolean;
  bestPath: string;
  periodMode: PeriodMode;
  fixedPeriod: string;
}

export interface ExternalFeedConfig {
  enabled: boolean;
  activeProvider: string;
  mixCreatorsFirst: boolean;
  pagesPerRequest: number;
  providers: Record<string, ExternalFeedProvider>;
  resolvedPeriod?: string | null;
}

export async function fetchExternalFeedConfig(): Promise<ExternalFeedConfig> {
  const res = await apiFetch<{ success: boolean; config: ExternalFeedConfig }>('/external-feed');
  return res.config;
}

export async function saveExternalFeedConfig(config: ExternalFeedConfig): Promise<ExternalFeedConfig> {
  const res = await apiFetch<{ success: boolean; config: ExternalFeedConfig }>('/external-feed', {
    method: 'PUT',
    body: JSON.stringify({ config }),
  });
  return res.config;
}

export async function testExternalFeed(page = 1): Promise<{
  success: boolean;
  message: string;
  sampleCount?: number;
  period?: string | null;
  preview?: Array<{ id: string; title: string; thumbnail?: string }>;
}> {
  return apiFetch(`/external-feed/test?page=${encodeURIComponent(String(page))}`, { method: 'POST' });
}
