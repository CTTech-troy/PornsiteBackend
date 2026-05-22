import { API_BASE, apiMessage, readApiResponse } from './http';

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
  const res = await fetch(`${API_BASE}/api/admin/coins${path}`, {
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

export interface CoinPackage {
  id: string;
  name: string;
  description: string;
  coins: number;
  bonusCoins: number;
  totalCoins: number;
  priceUsd: number;
  priceNgn: number;
  currency: string;
  isActive: boolean;
  sortOrder: number;
}

export interface CoinStats {
  totalWallets: number;
  activePackages: number;
  totalCoinLiability: number;
  totalCoinsSold: number;
  totalCoinsSpent: number;
  transactionCount: number;
}

export interface CoinTransaction {
  id: string;
  userId: string;
  type: string;
  amount: number;
  balanceAfter?: number;
  status: string;
  reference?: string | null;
  relatedUserId?: string | null;
  createdAt: string;
}

export interface CoinWallet {
  userId: string;
  balance: number;
  lifetimePurchased: number;
  lifetimeSpent: number;
  lifetimeReceived: number;
  lifetimeAdjusted: number;
}

export function fetchCoinPackages(): Promise<{ success: boolean; data: CoinPackage[]; stats: CoinStats }> {
  return apiFetch('/packages');
}

export function createCoinPackage(payload: Partial<CoinPackage>): Promise<{ success: boolean; data: CoinPackage }> {
  return apiFetch('/packages', { method: 'POST', body: JSON.stringify(payload) });
}

export function updateCoinPackage(id: string, payload: Partial<CoinPackage>): Promise<{ success: boolean; data: CoinPackage }> {
  return apiFetch(`/packages/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
}

export function toggleCoinPackage(id: string, isActive: boolean): Promise<{ success: boolean; data: CoinPackage }> {
  return apiFetch(`/packages/${id}/toggle`, { method: 'PATCH', body: JSON.stringify({ isActive }) });
}

export function deleteCoinPackage(id: string): Promise<{ success: boolean }> {
  return apiFetch(`/packages/${id}`, { method: 'DELETE' });
}

export function fetchCoinWallet(userId: string): Promise<{
  success: boolean;
  wallet: CoinWallet;
  transactions: CoinTransaction[];
  total: number;
}> {
  return apiFetch(`/wallets/${encodeURIComponent(userId)}`);
}

export function adjustCoinWallet(userId: string, payload: { amount?: number; targetBalance?: number; reason?: string }): Promise<{
  success: boolean;
  balance: number;
  transactionId: string | null;
}> {
  return apiFetch(`/wallets/${encodeURIComponent(userId)}/adjust`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export interface GiftCatalogItem {
  id: string;
  name: string;
  coinCost: number;
  emoji: string | null;
  tone: string | null;
  sortOrder: number;
  isActive: boolean;
}

export interface GiftCatalogStats {
  total: number;
  active: number;
}

export function fetchGiftCatalog(): Promise<{
  success: boolean;
  data: GiftCatalogItem[];
  stats: GiftCatalogStats;
}> {
  return apiFetch('/gifts');
}

export function createGiftCatalogItem(payload: Partial<GiftCatalogItem>): Promise<{ success: boolean; data: GiftCatalogItem }> {
  return apiFetch('/gifts', { method: 'POST', body: JSON.stringify(payload) });
}

export function updateGiftCatalogItem(id: string, payload: Partial<GiftCatalogItem>): Promise<{ success: boolean; data: GiftCatalogItem }> {
  return apiFetch(`/gifts/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(payload) });
}

export function toggleGiftCatalogItem(id: string, isActive: boolean): Promise<{ success: boolean; data: GiftCatalogItem }> {
  return apiFetch(`/gifts/${encodeURIComponent(id)}/toggle`, { method: 'PATCH', body: JSON.stringify({ isActive }) });
}

export function deleteGiftCatalogItem(id: string): Promise<{ success: boolean }> {
  return apiFetch(`/gifts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function fetchCoinTransactions(userId: string, page = 1, limit = 25): Promise<{
  success: boolean;
  transactions: CoinTransaction[];
  total: number;
  page: number;
  limit: number;
}> {
  return apiFetch(`/transactions/${encodeURIComponent(userId)}?page=${page}&limit=${limit}`);
}
