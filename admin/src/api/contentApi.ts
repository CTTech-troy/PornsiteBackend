import { API_BASE, apiMessage, readApiResponse } from './http';

function getToken(): string {
  return localStorage.getItem('admin_token') || '';
}

function authHeaders(): HeadersInit {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` };
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}/api/admin/content${path}`, {
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

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Video {
  id: string;
  title: string;
  thumbnail: string | null;
  creatorName: string;
  channelName: string;
  uploadDate: number | null;
  status: string;
  visibility: string;
  views: number;
  likes: number;
  reports: number;
  earnings: number;
  price?: number;
  isPremiumContent?: boolean;
  tokenPrice?: number;
  videoUrl: string | null;
  duration: number | null;
  description: string;
  tags: string[];
}

export interface LiveSession {
  id: string;
  host_id: string;
  hostName: string;
  hostAvatar: string | null;
  status: string;
  viewers_count: number;
  total_likes: number;
  total_gifts_amount: number;
  created_at: string;
  ended_at: string | null;
  title: string | null;
  thumbnail_url: string | null;
}

export interface RandomSession {
  id: string;
  user1_id?: string;
  user2_id?: string;
  status: string;
  created_at: string;
  ended_at?: string | null;
  [key: string]: unknown;
}

// ── Videos ───────────────────────────────────────────────────────────────────

export function fetchVideos(params: {
  page?: number; limit?: number; search?: string; statusFilter?: string;
}): Promise<{ videos: Video[]; total: number; page: number; limit: number }> {
  const q = new URLSearchParams();
  if (params.page) q.set('page', String(params.page));
  if (params.limit) q.set('limit', String(params.limit));
  if (params.search) q.set('search', params.search);
  if (params.statusFilter) q.set('statusFilter', params.statusFilter);
  return apiFetch(`/videos?${q}`);
}

export function fetchVideoById(id: string): Promise<{ video: Video }> {
  return apiFetch(`/videos/${id}`);
}

export function updateVideoStatus(id: string, status: string, reason?: string): Promise<{ message: string }> {
  return apiFetch(`/videos/${id}/status`, { method: 'PUT', body: JSON.stringify({ status, reason }) });
}

export function deleteVideo(id: string, reason?: string): Promise<{ message: string }> {
  return apiFetch(`/videos/${id}`, { method: 'DELETE', body: JSON.stringify({ reason }) });
}

// ── Premium Videos ────────────────────────────────────────────────────────────
// Reuses the /videos endpoint with isPremium=true — no separate premium route.

export function fetchPremiumVideos(params: {
  page?: number; limit?: number; search?: string; statusFilter?: string;
}): Promise<{ videos: Video[]; total: number; page: number; limit: number }> {
  const q = new URLSearchParams();
  q.set('isPremium', 'true');
  if (params.page) q.set('page', String(params.page));
  if (params.limit) q.set('limit', String(params.limit));
  if (params.search) q.set('search', params.search);
  if (params.statusFilter) q.set('statusFilter', params.statusFilter);
  return apiFetch(`/videos?${q}`);
}

// ── Live Sessions ─────────────────────────────────────────────────────────────

export function fetchLiveSessions(params: {
  page?: number; limit?: number; search?: string; statusFilter?: string;
}): Promise<{ lives: LiveSession[]; total: number; page: number; limit: number }> {
  const q = new URLSearchParams();
  if (params.page) q.set('page', String(params.page));
  if (params.limit) q.set('limit', String(params.limit));
  if (params.search) q.set('search', params.search);
  if (params.statusFilter) q.set('statusFilter', params.statusFilter);
  return apiFetch(`/lives?${q}`);
}

export interface LiveGift {
  id: string;
  sender_id: string;
  sender_username?: string;
  gift_type?: string;
  name?: string;
  amount: number;
  created_at: string;
}

export interface LiveViewer {
  id: string;
  user_id: string;
  username?: string;
  joined_at: string;
  left_at?: string | null;
}

export interface LiveSessionDetail {
  live: LiveSession & { hostName: string; hostAvatar: string | null };
  gifts: LiveGift[];
  viewers: LiveViewer[];
}

export function fetchLiveSessionById(id: string): Promise<LiveSessionDetail> {
  return apiFetch(`/lives/${id}`);
}

export function updateLiveStatus(id: string, status: string, reason?: string): Promise<{ message: string }> {
  return apiFetch(`/lives/${id}/status`, { method: 'PUT', body: JSON.stringify({ status, reason }) });
}

// ── Random Sessions ───────────────────────────────────────────────────────────

export function fetchRandomSessions(params: {
  page?: number; limit?: number; search?: string; statusFilter?: string;
}): Promise<{ sessions: RandomSession[]; total: number; page: number; limit: number }> {
  const q = new URLSearchParams();
  if (params.page) q.set('page', String(params.page));
  if (params.limit) q.set('limit', String(params.limit));
  if (params.search) q.set('search', params.search);
  if (params.statusFilter) q.set('statusFilter', params.statusFilter);
  return apiFetch(`/random-sessions?${q}`);
}
