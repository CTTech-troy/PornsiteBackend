import { API_BASE, apiMessage, readApiResponse } from './http';

function getToken(): string {
  return localStorage.getItem('admin_token') || '';
}

function authHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${getToken()}`,
  };
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}/api/admin/memberships${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...init?.headers },
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

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MembershipPlan {
  id: string;
  title: string;
  description: string;
  price: number;
  currency: string;
  duration: string;
  durationType?: 'days' | 'weeks' | 'months' | 'years' | string;
  durationValue?: number;
  features: string[];
  badge?: string | null;
  permissions?: Record<string, unknown>;
  limits?: Record<string, unknown>;
  creatorBenefits?: Record<string, unknown>;
  aiAccess?: Record<string, unknown>;
  visibilityPriority?: number;
  coinBonus?: number;
  isRecurring?: boolean;
  image: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface PlanStats {
  total: number;
  active: number;
  disabled: number;
}

export interface PlansResponse {
  success: boolean;
  data: MembershipPlan[];
  stats: PlanStats;
}

export interface CreatePlanPayload {
  title: string;
  description?: string;
  price: number;
  currency?: string;
  duration?: string;
  durationType?: string;
  durationValue?: number;
  features?: string[];
  badge?: string | null;
  permissions?: Record<string, unknown>;
  limits?: Record<string, unknown>;
  creatorBenefits?: Record<string, unknown>;
  aiAccess?: Record<string, unknown>;
  visibilityPriority?: number;
  coinBonus?: number;
  isRecurring?: boolean;
  image?: string | null;
  isActive?: boolean;
  sortOrder?: number;
}

export type UpdatePlanPayload = Partial<Omit<CreatePlanPayload, 'title'>> & { title?: string };

// ── API functions ─────────────────────────────────────────────────────────────

export async function fetchMembershipPlans(): Promise<PlansResponse> {
  return apiFetch<PlansResponse>('/');
}

export async function createMembershipPlan(payload: CreatePlanPayload): Promise<{ success: boolean; data: MembershipPlan }> {
  return apiFetch('/', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateMembershipPlan(id: string, payload: UpdatePlanPayload): Promise<{ success: boolean; data: MembershipPlan }> {
  return apiFetch(`/${id}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export async function toggleMembershipPlan(id: string, isActive: boolean): Promise<{ success: boolean; isActive: boolean }> {
  return apiFetch(`/${id}/toggle`, {
    method: 'PATCH',
    body: JSON.stringify({ isActive }),
  });
}

export async function deleteMembershipPlan(id: string): Promise<{ success: boolean }> {
  return apiFetch(`/${id}`, { method: 'DELETE' });
}

export async function uploadPlanImage(file: File): Promise<{ success: boolean; url: string }> {
  const formData = new FormData();
  formData.append('image', file);
  const res = await fetch(`${API_BASE}/api/admin/memberships/upload-image`, {
    method: 'POST',
    headers: authHeaders(),
    body: formData,
  });
  if (res.status === 401) {
    localStorage.removeItem('admin_token');
    window.location.href = '/login';
    throw new Error('Session expired.');
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || data.message || 'Upload failed');
  return data;
}
