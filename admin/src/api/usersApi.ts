import { API_BASE, apiMessage, readApiResponse } from './http';

function getToken(): string {
  return localStorage.getItem('admin_token') || '';
}

function authHeaders(): HeadersInit {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` };
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}/api/admin${path}`, {
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

// ── Types ────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  username: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  coin_balance: number;
  active_plan: string | null;
  plan_expires_at: string | null;
  is_creator: boolean;
  creator_status: string;
  status: string;          // 'active' | 'suspended' | 'banned' — derived
  is_verified: boolean;
  followers: number;
  following: number;
  created_at: string;
  auth_provider?: string | null;
  source?: string | null;
  source_tags?: string[];
  firebase_uid?: string | null;
  firestore_uid?: string | null;
  rtdb_uid?: string | null;
  supabase_user_id?: string | null;
}

export interface UserMembership {
  plan_id: string;
  amount_paid_usd: number;
  status: string;
  started_at: string;
  expires_at: string;
}

/** Shape returned by GET /api/admin/users/:id */
export interface UserDetailResponse {
  user: User;
  membership: UserMembership | null;
  earnings: number | null;
  adminHistory: AdminAction[];
}

export interface AdminAction {
  admin_name: string;
  action: string;
  details: Record<string, unknown>;
  created_at: string;
}

export interface Creator {
  id: string;
  user_id: string;
  username: string;
  display_name: string;
  creator_type: 'pstar' | 'channel' | string;
  email: string;
  avatar_url: string | null;
  status: string;
  is_verified: boolean;
  followers: number;
  created_at: string;
  [key: string]: unknown;
}

export interface CreatorMainApplication {
  id: string;
  user_id: string;
  full_name: string;
  email: string;
  phone: string;
  country: string;
  state: string;
  city: string;
  streetAddress: string;
  addressLine2: string;
  postalCode: string;
  creator_type: 'pstar' | 'channel' | string;
  bio: string;
  social_links: Record<string, string>;
  category: string;
  experience: string;
  profile_picture: string | null;
  uploaded_photos: string[];
  uploaded_videos: string[];
  status: 'pending' | 'approved' | 'rejected' | 'info_requested' | 'banned' | string;
  approved: boolean;
  rejected: boolean;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
  users?: {
    username: string;
    email: string;
    avatar_url: string | null;
  };
  dateOfBirth?: string;
  ageAtSubmission?: number | string;
  gender?: string;
  idType?: string;
  idNumber?: string;
  contentType?: string;
  content_type?: string;
  mainOrientationCategory?: string;
  experienceLevel?: string;
  termsAccepted?: boolean;
  privacyAccepted?: boolean;
  dataProcessingAccepted?: boolean;
  ageConfirmed?: boolean;
  attachments?: Array<{ name?: string; url?: string; path?: string; contentType?: string; [key: string]: unknown }>;
  review_reason?: string | null;
  reviewed_at?: string | null;
  reviewed_by?: string | null;
  reviewed_by_name?: string | null;
  decision_at?: string | null;
  ban_reason?: string | null;
  ban_expires_at?: string | null;
  ban_admin_id?: string | null;
  creator_id?: string | null;
  creator_active?: boolean;
  creator_status?: string | null;
  raw_data?: ApplicationDetail['data'];
  data?: ApplicationDetail['data'];
  [key: string]: unknown;
}

// ── Users ─────────────────────────────────────────────────────────────────────

export function fetchUsers(params: {
  page?: number; limit?: number; search?: string;
  statusFilter?: string; planFilter?: string; verifiedFilter?: string;
}): Promise<{
  users: User[];
  data?: User[];
  total: number;
  totalUsers?: number;
  page: number;
  limit: number;
  mergedTotal?: number;
  rawSourceTotal?: number;
  supabaseTotal?: number;
  firebaseAuthTotal?: number;
  firestoreTotal?: number;
  rtdbTotal?: number;
  firebaseOnlyTotal?: number;
  sourceCounts?: {
    mergedTotal: number;
    filteredTotal?: number;
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
  dataSource?: string;
}> {
  const q = new URLSearchParams();
  if (params.page) q.set('page', String(params.page));
  if (params.limit) q.set('limit', String(params.limit));
  if (params.search) q.set('search', params.search);
  if (params.statusFilter) q.set('statusFilter', params.statusFilter);
  if (params.planFilter) q.set('planFilter', params.planFilter);
  if (params.verifiedFilter) q.set('verifiedFilter', params.verifiedFilter);
  return apiFetch(`/users?${q}`);
}

export function fetchUserById(id: string): Promise<UserDetailResponse> {
  return apiFetch(`/users/${id}`);
}

export function updateUserStatus(id: string, status: string, reason?: string): Promise<{ message: string }> {
  return apiFetch(`/users/${id}/status`, { method: 'PUT', body: JSON.stringify({ status, reason }) });
}

export function updateUserCoins(id: string, coin_balance: number): Promise<{ message: string }> {
  return apiFetch(`/users/${id}/coins`, { method: 'PUT', body: JSON.stringify({ coin_balance }) });
}

export function deleteUser(
  id: string,
  reason: string,
): Promise<{ message: string; deleted: boolean; emailSent: boolean; emailError?: string | null }> {
  return apiFetch(`/users/${id}`, {
    method: 'DELETE',
    body: JSON.stringify({ reason }),
  });
}

// ── Creators ──────────────────────────────────────────────────────────────────

export function fetchCreators(params: {
  page?: number; limit?: number; search?: string;
  statusFilter?: string; verifiedFilter?: string;
  typeFilter?: 'pstar' | 'channel' | '';
}): Promise<{ creators: Creator[]; total: number; page: number; limit: number }> {
  const q = new URLSearchParams();
  if (params.page)          q.set('page',          String(params.page));
  if (params.limit)         q.set('limit',         String(params.limit));
  if (params.search)        q.set('search',        params.search);
  if (params.statusFilter)  q.set('statusFilter',  params.statusFilter);
  if (params.verifiedFilter) q.set('verifiedFilter', params.verifiedFilter);
  if (params.typeFilter)    q.set('typeFilter',    params.typeFilter);
  return apiFetch(`/creators?${q}`);
}

export function updateCreatorStatus(id: string, status: string, reason?: string): Promise<{ message: string }> {
  return apiFetch(`/creators/${id}/status`, { method: 'PUT', body: JSON.stringify({ status, reason }) });
}

export function updateCreatorType(userId: string, creator_type: 'pstar' | 'channel'): Promise<{ message: string }> {
  return apiFetch(`/users/${userId}/creator-type`, { method: 'PUT', body: JSON.stringify({ creator_type }) });
}

// ── Creator Applications ──────────────────────────────────────────────────────

export interface ApplicationDetail {
  id: string;
  user_id: string;
  status: string;
  created_at: string;
  username: string;
  email?: string;
  is_verified?: boolean;
  avatar_url: string | null;
  review_reason?: string | null;
  reviewed_at?: string | null;
  reviewed_by?: string | null;
  reviewed_by_name?: string | null;
  decision_at?: string | null;
  missing_fields?: unknown[];
  ban_reason?: string | null;
  ban_expires_at?: string | null;
  ban_admin_id?: string | null;
  creator_id?: string | null;
  creator_active?: boolean;
  creator_status?: string | null;
  data: {
    firstName?: string; lastName?: string; displayName?: string;
    dateOfBirth?: string; gender?: string; bio?: string;
    email?: string; phone?: string; houseDetails?: string;
    streetAddress?: string; city?: string; lga?: string; state?: string; country?: string;
    idType?: string; idNumber?: string;
    content?: string; creatorCategory?: string; creatorMode?: string; experienceLevel?: string;
    instagramUrl?: string; xUrl?: string; tiktokUrl?: string; youtubeUrl?: string; websiteUrl?: string;
    verificationPhrase?: string; verificationStatus?: string;
    termsAccepted?: boolean; privacyAccepted?: boolean;
    dataProcessingAccepted?: boolean; ageConfirmed?: boolean;
    ageAtSubmission?: number | string; minimumCreatorAge?: number | string;
    creator_type?: string;
    attachments?: Array<{ name: string; url: string; contentType: string }>;
    [key: string]: unknown;
  };
}

interface LegacyCreatorApplicationRow {
  id: string;
  user_id: string;
  name?: string;
  username?: string;
  email?: string;
  avatar_url?: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'info_requested' | string;
  creator_type?: string;
  category?: string;
  content_type?: string;
  application_message?: string;
  is_verified?: boolean;
  created_at: string;
  submitted_at?: string;
  review_reason?: string | null;
  rejection_reason?: string | null;
  reviewed_at?: string | null;
  reviewed_by?: string | null;
  reviewed_by_name?: string | null;
  decision_at?: string | null;
  ban_reason?: string | null;
  ban_expires_at?: string | null;
  ban_admin_id?: string | null;
  creator_id?: string | null;
  creator_active?: boolean;
  creator_status?: string | null;
}

function normalizeCreatorStatus(status?: string): CreatorMainApplication['status'] {
  if (status === 'approved' || status === 'rejected' || status === 'info_requested' || status === 'banned') return status;
  return 'pending';
}

function socialLinksFromApplicationData(data: ApplicationDetail['data'] = {}) {
  return {
    instagram: String(data.instagramUrl || ''),
    x: String(data.xUrl || ''),
    tiktok: String(data.tiktokUrl || ''),
    youtube: String(data.youtubeUrl || ''),
    website: String(data.websiteUrl || ''),
  };
}

function attachmentsByType(data: ApplicationDetail['data'] = {}, typePrefix: string) {
  return (data.attachments || [])
    .filter((file) => String(file.contentType || '').toLowerCase().startsWith(typePrefix))
    .map((file) => file.url)
    .filter(Boolean);
}

function mapLegacyApplicationRow(row: LegacyCreatorApplicationRow): CreatorMainApplication {
  const status = normalizeCreatorStatus(row.status);
  return {
    id: row.id,
    user_id: row.user_id,
    full_name: row.name || row.username || row.user_id,
    email: row.email || '',
    phone: '',
    country: '',
    state: '',
    city: '',
    streetAddress: '',
    addressLine2: '',
    postalCode: '',
    creator_type: row.creator_type || '',
    bio: row.application_message || '',
    social_links: {},
    category: row.category || row.creator_type || '',
    experience: row.application_message || '',
    profile_picture: row.avatar_url || null,
    uploaded_photos: [],
    uploaded_videos: [],
    status,
    approved: status === 'approved',
    rejected: status === 'rejected',
    rejection_reason: row.rejection_reason || row.review_reason || null,
    created_at: row.created_at || row.submitted_at || new Date().toISOString(),
    updated_at: row.decision_at || row.reviewed_at || row.submitted_at || row.created_at || new Date().toISOString(),
    review_reason: row.review_reason || null,
    reviewed_at: row.reviewed_at || null,
    reviewed_by: row.reviewed_by || null,
    reviewed_by_name: row.reviewed_by_name || null,
    decision_at: row.decision_at || null,
    ban_reason: row.ban_reason || null,
    ban_expires_at: row.ban_expires_at || null,
    ban_admin_id: row.ban_admin_id || null,
    creator_id: row.creator_id || null,
    creator_active: row.creator_active,
    creator_status: row.creator_status || null,
    users: {
      username: row.username || row.user_id,
      email: row.email || '',
      avatar_url: row.avatar_url || null,
    },
  };
}

function mapLegacyApplicationDetail(app: ApplicationDetail): CreatorMainApplication {
  const data = app.data || {};
  const applicationMessage =
    typeof data.application_message === 'string' ? data.application_message : '';
  const fullName =
    [data.firstName, data.lastName].filter(Boolean).join(' ') ||
    data.displayName ||
    app.username ||
    app.user_id;
  const photos = attachmentsByType(data, 'image/');
  const videos = attachmentsByType(data, 'video/');
  const status = normalizeCreatorStatus(app.status);

  return {
    id: app.id,
    user_id: app.user_id,
    full_name: fullName,
    email: data.email || app.email || '',
    phone: data.phone || '',
    country: data.country || '',
    state: data.state || '',
    city: data.city || data.lga || '',
    streetAddress: String(data.streetAddress || data.address || ''),
    addressLine2: String(data.addressLine2 || data.houseDetails || ''),
    postalCode: typeof data.postalCode === 'string' ? data.postalCode : '',
    creator_type: data.creator_type || '',
    bio: data.bio || data.content || '',
    social_links: socialLinksFromApplicationData(data),
    category: data.creatorCategory || data.creatorMode || '',
    experience: data.experienceLevel || data.creatorMode || applicationMessage,
    profile_picture: photos[0] || app.avatar_url || null,
    uploaded_photos: photos,
    uploaded_videos: videos,
    status,
    approved: status === 'approved',
    rejected: status === 'rejected',
    rejection_reason: app.review_reason || null,
    created_at: app.created_at,
    updated_at: app.decision_at || app.reviewed_at || app.created_at,
    dateOfBirth: String(data.dateOfBirth || data.dob || ''),
    ageAtSubmission: data.ageAtSubmission,
    gender: typeof data.gender === 'string' ? data.gender : '',
    idType: typeof data.idType === 'string' ? data.idType : '',
    idNumber: typeof data.idNumber === 'string' ? data.idNumber : '',
    contentType: String(data.contentType || data.content_type || data.mainOrientationCategory || ''),
    content_type: String(data.content_type || data.contentType || ''),
    mainOrientationCategory: String(data.mainOrientationCategory || data.contentType || ''),
    experienceLevel: typeof data.experienceLevel === 'string' ? data.experienceLevel : '',
    termsAccepted: Boolean(data.termsAccepted),
    privacyAccepted: Boolean(data.privacyAccepted),
    dataProcessingAccepted: Boolean(data.dataProcessingAccepted),
    ageConfirmed: Boolean(data.ageConfirmed),
    attachments: data.attachments || [],
    review_reason: app.review_reason || null,
    reviewed_at: app.reviewed_at || null,
    reviewed_by: app.reviewed_by || null,
    reviewed_by_name: app.reviewed_by_name || null,
    decision_at: app.decision_at || null,
    ban_reason: app.ban_reason || null,
    ban_expires_at: app.ban_expires_at || null,
    ban_admin_id: app.ban_admin_id || null,
    creator_id: app.creator_id || null,
    creator_active: app.creator_active,
    creator_status: app.creator_status || null,
    raw_data: data,
    data,
    users: {
      username: app.username || app.user_id,
      email: data.email || app.email || '',
      avatar_url: app.avatar_url || null,
    },
  };
}

export function fetchApplicationById(id: string): Promise<ApplicationDetail> {
  return apiFetch(`/applications/${id}`);
}

export function fetchCreatorMainApplications(params: {
  page?: number; limit?: number; search?: string; status?: string;
}): Promise<{ success: boolean; applications: CreatorMainApplication[]; total: number; page: number; limit: number }> {
  const q = new URLSearchParams();
  if (params.page) q.set('page', String(params.page));
  if (params.limit) q.set('limit', String(params.limit));
  if (params.search) q.set('search', params.search);
  if (params.status) q.set('statusFilter', params.status);
  return apiFetch<{ applications: LegacyCreatorApplicationRow[]; total: number; page: number; limit: number }>(`/applications?${q}`)
    .then((res) => ({
      success: true,
      applications: (res.applications || []).map(mapLegacyApplicationRow),
      total: res.total || 0,
      page: res.page || params.page || 1,
      limit: res.limit || params.limit || 20,
    }));
}

export function fetchCreatorMainApplicationById(id: string): Promise<{ success: boolean; application: CreatorMainApplication }> {
  return apiFetch<ApplicationDetail>(`/applications/${id}`)
    .then((application) => ({ success: true, application: mapLegacyApplicationDetail(application) }));
}

export function approveCreatorMainApplication(id: string, reason?: string): Promise<{ success: boolean; message: string }> {
  return apiFetch<{ message: string }>(`/applications/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'approved', reason: reason?.trim() || 'Approved by admin' }),
  }).then((res) => ({ success: true, message: res.message }));
}

export function rejectCreatorMainApplication(id: string, reason: string): Promise<{ success: boolean; message: string }> {
  return apiFetch<{ message: string }>(`/applications/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'rejected', reason }),
  }).then((res) => ({ success: true, message: res.message }));
}

export function reconsiderCreatorMainApplication(id: string, reason?: string): Promise<{ success: boolean; message: string }> {
  return apiFetch<{ message: string }>(`/applications/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'pending', reason: reason?.trim() || 'Reopened for review by admin' }),
  }).then((res) => ({ success: true, message: res.message }));
}

export function banCreatorMainApplication(id: string, reason: string, banExpiresAt?: string): Promise<{ success: boolean; message: string }> {
  return apiFetch<{ message: string }>(`/applications/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'banned', reason, banExpiresAt: banExpiresAt || null }),
  }).then((res) => ({ success: true, message: res.message }));
}

export function removeCreatorAccessFromApplication(id: string, reason: string): Promise<{ success: boolean; message: string }> {
  return apiFetch<{ message: string }>(`/applications/${id}/remove-access`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  }).then((res) => ({ success: true, message: res.message }));
}

export function deleteCreatorMainApplication(id: string, reason: string): Promise<{ success: boolean; message: string }> {
  return apiFetch<{ message: string }>(`/applications/${id}`, {
    method: 'DELETE',
    body: JSON.stringify({ reason }),
  }).then((res) => ({ success: true, message: res.message }));
}
