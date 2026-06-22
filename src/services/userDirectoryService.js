import {
  supabase,
  isSupabaseAvailable,
  isSupabaseNetworkError,
  markSupabaseUnavailable,
} from '../config/supabase.js';
import { admin, getFirebaseAuth, getFirebaseDb, getFirebaseRtdb } from '../config/firebase.js';

export function paginateAdmin(page, limit) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(500, Math.max(1, parseInt(limit, 10) || 50));
  return { page: p, limit: l, offset: (p - 1) * l };
}

export async function safeCount(queryBuilder) {
  try {
    const { count, error } = await queryBuilder;
    if (error) return 0;
    return count || 0;
  } catch {
    return 0;
  }
}

function defaultAvatarUrl(seed) {
  const s = encodeURIComponent(String(seed || 'user').slice(0, 80));
  return `https://api.dicebear.com/7.x/avataaars/svg?seed=${s}`;
}

export function rowToAdminUserDto(u) {
  const email = String(u.email || '').trim().toLowerCase();
  const username = String(u.username || u.id || '').trim() || String(u.id || '');
  const fullName = String(u.full_name || u.display_name || u.displayName || u.name || username || '').trim() || username;
  const rawA = u.avatar_url || u.avatar || u.photoURL || null;
  const avatar = rawA && String(rawA).trim() ? String(rawA).trim() : defaultAvatarUrl(email || u.id);
  const createdAt = u.created_at || u.createdAt || null;
  const updatedAt = u.updated_at || u.updatedAt || createdAt || null;
  const isCreator = !!(u.creator === true || u.is_creator === true);
  const rawCreatorStatus = String(
    u.creator_status || u.creatorStatus || (typeof u.verified === 'string' ? u.verified : '') || ''
  ).trim();
  const creatorStatus = isCreator
    ? 'approved'
    : (['pending', 'rejected', 'info_requested'].includes(rawCreatorStatus) ? rawCreatorStatus : 'none');
  const accountStatus = u.banned ? 'banned' : u.suspended ? 'suspended' : 'active';
  const coinBalance = Number(u.coin_balance ?? u.coinBalance ?? u.balance) || 0;
  const isVerified = !!(u.email_verified === true || u.emailVerified === true || u.is_verified === true);
  return {
    id: u.id,
    username,
    display_name: fullName,
    fullName,
    full_name: fullName,
    email,
    avatar_url: avatar,
    avatar,
    verified: isVerified,
    is_verified: isVerified,
    role: u.role || 'user',
    createdAt,
    created_at: createdAt,
    updatedAt,
    updated_at: updatedAt,
    isCreator,
    is_creator: isCreator,
    creatorStatus,
    creator_status: creatorStatus,
    accountStatus,
    status: accountStatus,
    followers: Number(u.followers) || 0,
    following: Number(u.following) || 0,
    coinBalance,
    coin_balance: coinBalance,
    active_plan: u.active_plan || u.activePlan || null,
    plan_expires_at: u.plan_expires_at || u.planExpiresAt || null,
    auth_provider: u.auth_provider || (Array.isArray(u.source_tags) && u.source_tags.some((s) => String(s).startsWith('firebase')) ? 'firebase' : null),
    source: u.source || (Array.isArray(u.source_tags) ? u.source_tags.join('+') : null),
    source_tags: Array.isArray(u.source_tags) ? u.source_tags : [],
    firebase_uid: u.firebase_uid || u.firestore_uid || u.rtdb_uid || null,
    firestore_uid: u.firestore_uid || null,
    rtdb_uid: u.rtdb_uid || null,
    supabase_user_id: u.supabase_user_id || null,
  };
}

function dateLikeToIso(value) {
  if (!value) return null;
  if (typeof value?.toDate === 'function') {
    return firebaseTimeToIso(value.toDate());
  }
  if (typeof value === 'object' && Number.isFinite(value._seconds)) {
    return new Date(value._seconds * 1000).toISOString();
  }
  return firebaseTimeToIso(value);
}

export function rtdbUserToRow(id, u) {
  const o = typeof u === 'object' && u !== null ? u : {};
  return {
    ...o,
    id,
    username: o.username || o.displayName || id,
    email: o.email || '',
    full_name: o.full_name || o.display_name || o.name,
    display_name: o.display_name || o.displayName || o.name,
    avatar_url: o.avatar_url || o.avatar,
    avatar: o.avatar || o.avatar_url,
    email_verified: !!(o.emailVerified || o.email_verified),
    emailVerified: o.emailVerified,
    role: o.role || 'user',
    creator: !!o.creator,
    verified: o.creatorStatus ?? o.verified,
    followers: o.followers,
    following: o.following,
    created_at: dateLikeToIso(o.created_at || o.createdAt),
    updated_at: dateLikeToIso(o.updated_at || o.updatedAt),
    banned: o.banned,
    suspended: o.suspended,
    rtdb_uid: id,
    auth_provider: 'firebase',
    source: 'firebase_rtdb',
  };
}

export function firestoreUserDocToRow(id, u) {
  const o = typeof u === 'object' && u !== null ? u : {};
  const email = String(o.email || '').trim().toLowerCase();
  const displayName = String(o.display_name || o.displayName || o.full_name || o.name || '').trim();
  const username = String(o.username || displayName || (email ? email.split('@')[0] : '') || id).trim();
  return {
    ...o,
    id,
    username,
    email,
    full_name: o.full_name || o.fullName || displayName || username,
    display_name: o.display_name || o.displayName || displayName || username,
    avatar_url: o.avatar_url || o.avatar || o.photoURL || null,
    avatar: o.avatar || o.avatar_url || o.photoURL || null,
    email_verified: !!(o.email_verified || o.emailVerified),
    emailVerified: !!(o.emailVerified || o.email_verified),
    role: o.role || 'user',
    creator: !!o.creator,
    creator_status: o.creatorStatus || o.creator_status || o.verified || 'none',
    verified: o.verified || o.creatorStatus || 'none',
    followers: o.followers,
    following: o.following,
    coin_balance: o.coin_balance ?? o.coinBalance ?? o.tokenBalance,
    created_at: dateLikeToIso(o.created_at || o.createdAt),
    updated_at: dateLikeToIso(o.updated_at || o.updatedAt),
    banned: o.banned,
    suspended: o.suspended,
    firestore_uid: id,
    firebase_uid: id,
    auth_provider: 'firebase',
    source: 'firebase_firestore',
  };
}

const MAX_RTDB_USER_SCAN = Math.min(8000, Math.max(100, Number(process.env.ADMIN_MAX_RTDB_USER_SCAN || 2000)));
const MAX_AUTH_USER_SCAN = Math.min(10000, Math.max(100, Number(process.env.ADMIN_MAX_AUTH_USER_SCAN || 2500)));
const MAX_FIRESTORE_USER_SCAN = Math.min(10000, Math.max(100, Number(process.env.ADMIN_MAX_FIRESTORE_USER_SCAN || 2500)));
const PLATFORM_CREATOR_TYPE_SCAN_LIMIT = Math.min(20000, Math.max(100, Number(process.env.ADMIN_PLATFORM_CREATOR_TYPE_SCAN_LIMIT || 5000)));
const DIRECTORY_PROVIDER_TIMEOUT_MS = Math.max(3000, Number(process.env.ADMIN_DIRECTORY_PROVIDER_TIMEOUT_MS) || 12000);
const USER_DIRECTORY_SUPABASE_WARN_MS = Math.max(30000, Number(process.env.USER_DIRECTORY_SUPABASE_WARN_MS || 120000));
function firebaseDirectoryScanEnabled() {
  const raw = String(process.env.ADMIN_ENABLE_FIREBASE_DIRECTORY_SCAN || '').trim().toLowerCase();
  if (raw) return ['true', '1', 'yes', 'on'].includes(raw);
  return Boolean(
    String(process.env.FIREBASE_DATABASE_URL || '').trim()
    && (
      String(process.env.FIREBASE_SERVICE_ACCOUNT_KEY || '').trim()
      || String(process.env.FIREBASE_SERVICE_ACCOUNT || '').trim()
      || String(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '').trim()
      || String(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '').trim()
      || String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim()
    )
  );
}

const ADMIN_ENABLE_FIREBASE_DIRECTORY_SCAN = firebaseDirectoryScanEnabled();
let userDirectorySupabaseLastWarnAt = 0;

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function withTimeout(promise, label, timeoutMs = DIRECTORY_PROVIDER_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function warnSupabaseDirectoryFallback(context, err) {
  const message = err?.message || String(err || 'Unknown error');
  const isNetwork = markSupabaseUnavailable(err, context) || isSupabaseNetworkError(err);
  if (isNetwork) {
    const now = Date.now();
    if (!userDirectorySupabaseLastWarnAt || now - userDirectorySupabaseLastWarnAt > USER_DIRECTORY_SUPABASE_WARN_MS) {
      userDirectorySupabaseLastWarnAt = now;
      console.warn(`[userDirectory] ${context}: Supabase temporarily unreachable; using Firebase/local fallbacks: ${message}`);
    }
    return;
  }
  console.warn(`[userDirectory] ${context}`, message);
}

const USERS_FACET_REQUIRED_COLUMNS = 'id, username, display_name, avatar, avatar_url';
const USERS_FACET_OPTIONAL_COLUMNS = ['email', 'email_verified', 'full_name'];
const usersOptionalColumnAvailability = {};

function getMissingUsersColumnName(err) {
  if (!err) return null;
  const code = String(err?.code || '');
  const msg = String(err?.message || '').toLowerCase();
  if (code !== '42703' && code !== 'PGRST204' && !msg.includes('does not exist')) {
    return null;
  }
  for (const col of USERS_FACET_OPTIONAL_COLUMNS) {
    if (
      msg.includes(`column users.${col} does not exist`)
      || (msg.includes(`'${col}'`) && msg.includes('does not exist'))
    ) {
      return col;
    }
  }
  return null;
}

async function probeUsersOptionalColumn(column) {
  if (usersOptionalColumnAvailability[column] !== undefined) {
    return usersOptionalColumnAvailability[column];
  }
  if (!isSupabaseAvailable() || !supabase) {
    usersOptionalColumnAvailability[column] = false;
    return false;
  }
  const { error } = await supabase.from('users').select(column).limit(1);
  if (error) {
    if (getMissingUsersColumnName(error) === column) {
      usersOptionalColumnAvailability[column] = false;
      return false;
    }
    return false;
  }
  usersOptionalColumnAvailability[column] = true;
  return true;
}

async function usersFacetSelectColumns() {
  const cols = USERS_FACET_REQUIRED_COLUMNS.split(', ');
  for (const optional of USERS_FACET_OPTIONAL_COLUMNS) {
    if (await probeUsersOptionalColumn(optional)) {
      cols.push(optional);
    }
  }
  return cols.join(', ');
}

function userSearchOrFilter(searchTrim) {
  const term = String(searchTrim || '').trim().replace(/,/g, ' ').slice(0, 120);
  if (!term) return null;
  const parts = [
    `username.ilike.%${term}%`,
    `display_name.ilike.%${term}%`,
  ];
  if (usersOptionalColumnAvailability.email !== false) {
    parts.push(`email.ilike.%${term}%`);
  }
  if (usersOptionalColumnAvailability.full_name !== false) {
    parts.push(`full_name.ilike.%${term}%`);
  }
  return parts.join(',');
}

async function fetchUsersByIdsForFacets(ids) {
  const rows = [];
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    let selectCols = await usersFacetSelectColumns();
    let { data, error } = await supabase.from('users').select(selectCols).in('id', slice);
    while (error) {
      const missing = getMissingUsersColumnName(error);
      if (!missing) break;
      usersOptionalColumnAvailability[missing] = false;
      selectCols = await usersFacetSelectColumns();
      ({ data, error } = await supabase.from('users').select(selectCols).in('id', slice));
    }
    if (error) throw error;
    for (const r of data || []) rows.push(r);
  }
  return rows;
}

function firebaseTimeToIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function firebaseAuthUserToRow(userRecord) {
  const u = userRecord || {};
  const email = String(u.email || '').trim().toLowerCase();
  const displayName = String(u.displayName || '').trim();
  const username = displayName || (email ? email.split('@')[0] : '') || u.uid;
  return {
    id: u.uid,
    username,
    email,
    full_name: displayName || username,
    display_name: displayName || username,
    avatar_url: u.photoURL || null,
    avatar: u.photoURL || null,
    email_verified: u.emailVerified === true,
    emailVerified: u.emailVerified === true,
    role: 'user',
    creator: false,
    creator_status: 'none',
    verified: 'none',
    created_at: firebaseTimeToIso(u.metadata?.creationTime),
    updated_at: firebaseTimeToIso(u.metadata?.lastSignInTime) || firebaseTimeToIso(u.metadata?.lastRefreshTime),
    banned: false,
    suspended: u.disabled === true,
    firebase_uid: u.uid,
    auth_provider: 'firebase',
    source: 'firebase_auth',
  };
}

async function listFirebaseAuthRows({ enabled = ADMIN_ENABLE_FIREBASE_DIRECTORY_SCAN } = {}) {
  if (!enabled) return [];
  const auth = getFirebaseAuth();
  if (!auth) return [];
  const rows = [];
  let pageToken;
  try {
    do {
      const result = await withTimeout(auth.listUsers(1000, pageToken), 'Firebase Auth listUsers');
      for (const userRecord of result.users || []) {
        if (rows.length >= MAX_AUTH_USER_SCAN) break;
        rows.push(firebaseAuthUserToRow(userRecord));
      }
      pageToken = result.pageToken;
    } while (pageToken && rows.length < MAX_AUTH_USER_SCAN);
    if (pageToken) {
      console.warn('[userDirectory] Firebase Auth user scan capped');
    }
  } catch (err) {
    console.warn('[userDirectory] listFirebaseAuthRows', err?.message || err);
  }
  return rows;
}

async function listSupabaseUserRows() {
  if (!isSupabaseAvailable() || !supabase) return [];
  const rows = [];
  const CHUNK = 1000;
  for (let from = 0; from < MAX_AUTH_USER_SCAN; from += CHUNK) {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .order('created_at', { ascending: false })
      .range(from, from + CHUNK - 1);
    if (error) throw error;
    const batch = (data || []).map((row) => ({
      ...row,
      supabase_user_id: row.id,
      source: 'supabase',
    }));
    rows.push(...batch);
    if (batch.length < CHUNK) break;
  }
  return rows;
}

async function listFirestoreUserRows({ enabled = ADMIN_ENABLE_FIREBASE_DIRECTORY_SCAN } = {}) {
  if (!enabled) return [];
  const db = getFirebaseDb();
  if (!db) return [];
  const rows = [];
  const CHUNK = 500;
  let lastDoc = null;
  try {
    do {
      let query = db
        .collection('users')
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(CHUNK);
      if (lastDoc) query = query.startAfter(lastDoc);
      const snap = await withTimeout(query.get(), 'Firestore users scan');
      if (snap.empty) break;
      for (const doc of snap.docs) {
        if (rows.length >= MAX_FIRESTORE_USER_SCAN) break;
        rows.push(firestoreUserDocToRow(doc.id, doc.data() || {}));
      }
      lastDoc = snap.docs[snap.docs.length - 1] || null;
      if (snap.size < CHUNK) break;
    } while (lastDoc && rows.length < MAX_FIRESTORE_USER_SCAN);
    if (rows.length >= MAX_FIRESTORE_USER_SCAN) {
      console.warn('[userDirectory] Firestore user scan capped');
    }
  } catch (err) {
    console.warn('[userDirectory] listFirestoreUserRows', err?.message || err);
  }
  return rows;
}

async function listRtdbUserRows({ enabled = ADMIN_ENABLE_FIREBASE_DIRECTORY_SCAN } = {}) {
  if (!enabled) return [];
  const rtdb = getFirebaseRtdb();
  if (!rtdb) return [];
  try {
    const rows = [];
    let lastKey = null;
    const CHUNK = 500;
    do {
      let query = rtdb.ref('users').orderByKey();
      if (lastKey) query = query.startAt(lastKey);
      const requested = CHUNK + (lastKey ? 1 : 0);
      const snap = await withTimeout(query.limitToFirst(requested).once('value'), 'Firebase RTDB users scan');
      const entries = [];
      snap.forEach((child) => {
        entries.push([child.key, child.val()]);
        return false;
      });
      const pageRows = lastKey && entries[0]?.[0] === lastKey ? entries.slice(1) : entries;
      for (const [id, value] of pageRows) {
        if (!id || rows.length >= MAX_RTDB_USER_SCAN) break;
        rows.push(rtdbUserToRow(id, typeof value === 'object' && value !== null ? value : {}));
      }
      if (entries.length < requested || !pageRows.length || rows.length >= MAX_RTDB_USER_SCAN) break;
      lastKey = pageRows[pageRows.length - 1][0];
    } while (lastKey);
    if (rows.length >= MAX_RTDB_USER_SCAN) {
      console.warn('[userDirectory] RTDB user scan capped for admin list');
    }
    return rows;
  } catch (err) {
    console.warn('[userDirectory] listRtdbUserRows', err?.message || err);
    return [];
  }
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function sourceTagForRow(row) {
  const source = String(row?.source || '').trim();
  if (source) return source;
  if (row?.supabase_user_id) return 'supabase';
  if (row?.firestore_uid) return 'firebase_firestore';
  if (row?.rtdb_uid) return 'firebase_rtdb';
  if (row?.firebase_uid) return 'firebase_auth';
  return '';
}

function mergeUserRowsById(...sources) {
  const map = new Map();
  const idIndex = new Map();
  const emailIndex = new Map();
  for (const rows of sources) {
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row?.id && !row?.email) continue;
      const id = String(row.id || '').trim();
      const email = normalizeEmail(row.email);
      const existingKey = (id && idIndex.get(id)) || (email && emailIndex.get(email));
      const key = existingKey || id || `email:${email}`;
      const current = map.get(key) || { id };
      const sourceTag = sourceTagForRow(row);
      const sourceTags = new Set(Array.isArray(current.source_tags) ? current.source_tags : []);
      if (sourceTag) sourceTags.add(sourceTag);

      if (id) {
        if (sourceTag === 'supabase' && !current.supabase_user_id) current.supabase_user_id = id;
        if (sourceTag === 'firebase_auth' && !current.firebase_uid) current.firebase_uid = id;
        if (sourceTag === 'firebase_firestore' && !current.firestore_uid) current.firestore_uid = id;
        if (sourceTag === 'firebase_rtdb' && !current.rtdb_uid) current.rtdb_uid = id;
      }

      for (const [key, value] of Object.entries(row)) {
        if (key === 'id' || key === 'source' || key === 'source_tags') continue;
        if (hasValue(value) || typeof value === 'boolean' || value === 0) {
          current[key] = value;
        }
      }
      if (!current.id && id) current.id = id;
      current.source_tags = [...sourceTags];
      current.source = current.source_tags.join('+');
      map.set(key, current);
      if (id) idIndex.set(id, key);
      if (email) emailIndex.set(email, key);
    }
  }
  return [...map.values()];
}

function rowHasSource(row, source) {
  return Array.isArray(row?.source_tags) && row.source_tags.includes(source);
}

function rowHasFirebaseSource(row) {
  return Array.isArray(row?.source_tags) && row.source_tags.some((source) => String(source).startsWith('firebase'));
}

function buildDirectorySourceCounts(rows, sourceRows) {
  const mergedRows = Array.isArray(rows) ? rows : [];
  const supabaseRows = sourceRows?.supabaseRows || [];
  const authRows = sourceRows?.authRows || [];
  const firestoreRows = sourceRows?.firestoreRows || [];
  const rtdbRows = sourceRows?.rtdbRows || [];
  const rawSourceTotal = supabaseRows.length + authRows.length + firestoreRows.length + rtdbRows.length;

  return {
    mergedTotal: mergedRows.length,
    rawSourceTotal,
    supabaseTotal: supabaseRows.length,
    firebaseAuthTotal: authRows.length,
    firestoreTotal: firestoreRows.length,
    rtdbTotal: rtdbRows.length,
    firebaseSourceTotal: authRows.length + firestoreRows.length + rtdbRows.length,
    firebaseOnlyTotal: mergedRows.filter((row) => rowHasFirebaseSource(row) && !rowHasSource(row, 'supabase')).length,
    supabaseOnlyTotal: mergedRows.filter((row) => rowHasSource(row, 'supabase') && !rowHasFirebaseSource(row)).length,
    sharedProviderTotal: mergedRows.filter((row) => rowHasSource(row, 'supabase') && rowHasFirebaseSource(row)).length,
    deduplicatedTotal: Math.max(0, rawSourceTotal - mergedRows.length),
  };
}

async function collectMergedUserDirectoryRows({
  includeCreatorState = true,
  includeFirebaseSources = ADMIN_ENABLE_FIREBASE_DIRECTORY_SCAN,
} = {}) {
  const supabaseRowsPromise = (async () => {
    try {
      return await listSupabaseUserRows();
    } catch (err) {
      warnSupabaseDirectoryFallback('listSupabaseUserRows', err);
      return [];
    }
  })();

  const [supabaseRows, authRows, firestoreRows, rtdbRows] = await Promise.all([
    supabaseRowsPromise,
    listFirebaseAuthRows({ enabled: includeFirebaseSources }),
    listFirestoreUserRows({ enabled: includeFirebaseSources }),
    listRtdbUserRows({ enabled: includeFirebaseSources }),
  ]);

  let rows = mergeUserRowsById(authRows, firestoreRows, rtdbRows, supabaseRows);
  if (includeCreatorState) rows = await applyCreatorState(rows);
  const sourceRows = { supabaseRows, authRows, firestoreRows, rtdbRows };
  return {
    rows,
    sourceRows,
    counts: buildDirectorySourceCounts(rows, sourceRows),
  };
}

async function getCreatorStateByUserId(userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  const state = new Map();
  if (!ids.length || !isSupabaseAvailable() || !supabase) return state;

  const CHUNK = 400;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    try {
      const { data: creatorRows } = await supabase
        .from('creators')
        .select('user_id, creator_type')
        .in('user_id', slice);
      for (const row of creatorRows || []) {
        if (!row?.user_id) continue;
        state.set(row.user_id, {
          ...(state.get(row.user_id) || {}),
          isCreator: true,
          creatorStatus: 'approved',
          creatorType: row.creator_type || '',
        });
      }
    } catch {
      /* creator table may not exist yet */
    }

    try {
      const { data: appRows } = await supabase
        .from('creator_applications')
        .select('user_id, status, created_at')
        .in('user_id', slice)
        .order('created_at', { ascending: false });
      for (const app of appRows || []) {
        if (!app?.user_id) continue;
        const existing = state.get(app.user_id) || {};
        if (!existing.applicationStatus) {
          state.set(app.user_id, {
            ...existing,
            applicationStatus: app.status || 'pending',
          });
        }
      }
    } catch {
      /* application table may not exist yet */
    }

    try {
      const { data: mainAppRows } = await supabase
        .from('creators_main_application')
        .select('user_id, status, created_at')
        .in('user_id', slice)
        .order('created_at', { ascending: false });
      for (const app of mainAppRows || []) {
        if (!app?.user_id) continue;
        const existing = state.get(app.user_id) || {};
        if (!existing.applicationStatus) {
          state.set(app.user_id, {
            ...existing,
            applicationStatus: app.status || 'pending',
          });
        }
      }
    } catch {
      /* current application table may not exist yet */
    }
  }
  return state;
}

function candidateUserIdsForRow(row) {
  return [
    row?.id,
    row?.supabase_user_id,
    row?.firebase_uid,
    row?.firestore_uid,
    row?.rtdb_uid,
  ].filter(Boolean);
}

async function applyCreatorState(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const state = await getCreatorStateByUserId(list.flatMap(candidateUserIdsForRow));
  return list.map((row) => {
    const creator = candidateUserIdsForRow(row).map((id) => state.get(id)).find(Boolean) || {};
    const existingStatus = String(row.creator_status || row.creatorStatus || row.verified || '').trim();
    const applicationStatus = creator.applicationStatus || null;
    const isApproved =
      creator.isCreator === true ||
      row.creator === true ||
      row.is_creator === true ||
      existingStatus === 'approved';
    const creatorStatus = isApproved
      ? 'approved'
      : applicationStatus || (['pending', 'rejected', 'info_requested'].includes(existingStatus) ? existingStatus : 'none');
    return {
      ...row,
      creator: isApproved,
      is_creator: isApproved,
      creator_status: creatorStatus,
      creatorStatus,
      creator_type: creator.creatorType || row.creator_type || '',
      verified: creatorStatus,
    };
  });
}

export function applyAdminDirectoryFilters(rows, { searchTrim, statusFilter, verifiedFilter }) {
  let out = Array.isArray(rows) ? [...rows] : [];
  if (searchTrim) {
    const s = searchTrim.toLowerCase();
    out = out.filter((u) => {
      const un = String(u.username || '').toLowerCase();
      const em = String(u.email || '').toLowerCase();
      const fn = String(u.full_name || u.display_name || '').toLowerCase();
      return un.includes(s) || em.includes(s) || fn.includes(s);
    });
  }
  if (statusFilter === 'creator') out = out.filter((u) => !!u.creator);
  if (statusFilter === 'banned') out = out.filter((u) => u.banned);
  if (statusFilter === 'suspended') out = out.filter((u) => u.suspended);
  if (statusFilter === 'active') out = out.filter((u) => !u.banned && !u.suspended);
  if (verifiedFilter === 'true') out = out.filter((u) => !!u.email_verified);
  return out;
}

export async function countFirebaseOnlyUsers() {
  try {
    if (!ADMIN_ENABLE_FIREBASE_DIRECTORY_SCAN) return 0;
    const { counts } = await collectMergedUserDirectoryRows({
      includeCreatorState: false,
      includeFirebaseSources: true,
    });
    return counts.firebaseOnlyTotal;
  } catch (e) {
    console.warn('[userDirectory] countFirebaseOnlyUsers', e?.message || e);
    return 0;
  }
}

export async function listFirebaseOnlyUsersForAdmin(query) {
  const { search = '', verifiedFilter = '' } = query;
  const statusFilter = query.statusFilter || query.status || '';
  const { page, limit, offset } = paginateAdmin(query.page, query.limit || query.pageSize);
  const searchTrim = String(search || '').trim().replace(/,/g, ' ').slice(0, 120);
  try {
    const includeFirebaseSources = query.includeFirebaseSources === true
      || query.includeFirebaseSources === 'true'
      || ADMIN_ENABLE_FIREBASE_DIRECTORY_SCAN;
    if (!includeFirebaseSources) {
      return { users: [], total: 0, page, limit, disabled: true };
    }
    const { rows } = await collectMergedUserDirectoryRows({ includeCreatorState: true, includeFirebaseSources });
    let rowsOnly = rows.filter((row) => rowHasFirebaseSource(row) && !rowHasSource(row, 'supabase'));
    rowsOnly = applyAdminDirectoryFilters(rowsOnly, { searchTrim, statusFilter, verifiedFilter });
    rowsOnly.sort((a, b) => new Date(b.created_at || b.createdAt || 0).getTime() - new Date(a.created_at || a.createdAt || 0).getTime());
    const total = rowsOnly.length;
    const users = rowsOnly.slice(offset, offset + limit).map(rowToAdminUserDto);
    return { users, total, page, limit };
  } catch (e) {
    console.warn('[userDirectory] listFirebaseOnlyUsersForAdmin', e?.message || e);
    return { users: [], total: 0, page, limit };
  }
}

export async function buildAdminUserFacetsByIds(userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return {};
  const rows = [];
  if (isSupabaseAvailable() && supabase) {
    try {
      const fetched = await fetchUsersByIdsForFacets(ids);
      rows.push(...fetched);
    } catch (err) {
      warnSupabaseDirectoryFallback('buildAdminUserFacetsByIds', err);
    }
  }
  const have = new Set(rows.map((r) => r.id));
  for (const id of ids) {
    if (!have.has(id)) rows.push({ id });
  }
  const merged = await enrichUsersFromFirebase(rows);
  const map = {};
  for (const u of merged) {
    if (!u?.id) continue;
    map[u.id] = {
      username: u.username || u.id,
      display_name: u.display_name || u.full_name || u.username,
      email: u.email || null,
      avatar: u.avatar_url || u.avatar || null,
      email_verified: !!(u.email_verified || u.emailVerified),
    };
  }
  return map;
}

export async function enrichUsersFromFirebase(users) {
  const list = Array.isArray(users) ? users : [];
  const auth = getFirebaseAuth();
  const db = getFirebaseDb();
  if (!auth) {
    return list.map((u) => {
      const ev = u.email_verified === true || u.emailVerified === true;
      return { ...u, is_verified: !!(u.is_verified || ev) };
    });
  }

  const needs = list.filter((u) => {
    const needEmail = !String(u.email || '').trim();
    const needPic = !(u.avatar_url || u.avatar);
    const needName = !String(u.username || u.display_name || u.full_name || '').trim();
    return needEmail || needPic || needName;
  });
  if (!needs.length) return list;

  const uids = needs.map((u) => u.id).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < uids.length; i += 100) chunks.push(uids.slice(i, i + 100));

  const authMap = new Map();
  for (const batch of chunks) {
    try {
      const resp = await withTimeout(
        auth.getUsers(batch.map((uid) => ({ uid }))),
        'Firebase Auth getUsers'
      );
      for (const r of resp.users || []) {
        authMap.set(r.uid, {
          email: (r.email || '').trim().toLowerCase(),
          photoURL: r.photoURL || null,
          emailVerified: r.emailVerified === true,
          displayName: r.displayName || null,
        });
      }
    } catch {
      /* ignore */
    }
  }

  const fsMap = new Map();
  if (db) {
    const still = uids.filter((uid) => {
      const a = authMap.get(uid);
      return !a?.photoURL;
    });
    for (const uid of still) {
      try {
        const snap = await db.collection('users').doc(uid).get();
        if (snap.exists) {
          const d = snap.data() || {};
          fsMap.set(uid, { avatar: d.avatar || d.photoURL || null, email: d.email || '' });
        }
      } catch {
        /* ignore */
      }
    }
  }

  function rowComplete(u) {
    return (
      String(u.email || '').trim() &&
      (u.avatar_url || u.avatar) &&
      String(u.username || u.display_name || u.full_name || '').trim()
    );
  }

  return list.map((u) => {
    if (rowComplete(u)) {
      const ev = u.email_verified === true || u.emailVerified === true;
      return { ...u, is_verified: !!(u.is_verified || ev) };
    }
    const a = authMap.get(u.id) || {};
    const f = fsMap.get(u.id) || {};
    const mergedEmail = u.email || a.email || String(f.email || '').trim().toLowerCase();
    const mergedPic = u.avatar_url || u.avatar || a.photoURL || f.avatar || null;
    const fromAuthName = a.displayName && String(a.displayName).trim();
    const mergedDisplay = String(u.display_name || u.displayName || u.full_name || fromAuthName || '').trim();
    const mergedUsername = String(u.username || '').trim() || (mergedDisplay ? mergedDisplay.replace(/\s+/g, '_').toLowerCase() : '') || (mergedEmail ? mergedEmail.split('@')[0] : u.id);
    const emailVerified =
      u.email_verified === true || u.emailVerified === true || a.emailVerified === true;
    return {
      ...u,
      email: mergedEmail,
      username: mergedUsername,
      display_name: mergedDisplay || u.display_name || mergedUsername,
      avatar_url: mergedPic || u.avatar_url,
      avatar: mergedPic || u.avatar,
      email_verified: emailVerified,
      emailVerified: emailVerified,
      is_verified: !!(u.is_verified || emailVerified),
    };
  });
}

export async function getUserDirectoryAggregateStats(todayStart = new Date()) {
  const d = new Date(todayStart);
  d.setUTCHours(0, 0, 0, 0);
  if (isSupabaseAvailable() && supabase && !ADMIN_ENABLE_FIREBASE_DIRECTORY_SCAN) {
    const [
      totalUsers,
      emailVerifiedUsers,
      suspendedUsers,
      bannedUsers,
      newToday,
      platformCreators,
    ] = await Promise.all([
      safeCount(supabase.from('users').select('id', { count: 'exact', head: true })),
      safeCount(supabase.from('users').select('id', { count: 'exact', head: true }).eq('email_verified', true)),
      safeCount(supabase.from('users').select('id', { count: 'exact', head: true }).eq('suspended', true)),
      safeCount(supabase.from('users').select('id', { count: 'exact', head: true }).eq('banned', true)),
      safeCount(supabase.from('users').select('id', { count: 'exact', head: true }).gte('created_at', d.toISOString())),
      getSupabasePlatformCreatorCounts(),
    ]);
    const counts = {
      mergedTotal: totalUsers,
      rawSourceTotal: totalUsers,
      supabaseTotal: totalUsers,
      firebaseAuthTotal: 0,
      firestoreTotal: 0,
      rtdbTotal: 0,
      firebaseSourceTotal: 0,
      firebaseOnlyTotal: 0,
      supabaseOnlyTotal: totalUsers,
      sharedProviderTotal: 0,
      deduplicatedTotal: 0,
    };
    return {
      totalUsers,
      emailVerifiedUsers,
      suspendedUsers,
      bannedUsers,
      newToday,
      creatorsTotal: platformCreators.total,
      creatorsPstar: platformCreators.pstars,
      creatorsChannel: platformCreators.channels,
      firebaseOnlyUsers: 0,
      supabaseTotal: counts.supabaseTotal,
      firebaseAuthTotal: 0,
      firestoreTotal: 0,
      rtdbTotal: 0,
      firebaseSourceTotal: 0,
      mergedTotal: counts.mergedTotal,
      rawSourceTotal: counts.rawSourceTotal,
      deduplicatedTotal: 0,
      sourceCounts: counts,
    };
  }

  const { rows, counts } = await collectMergedUserDirectoryRows({
    includeCreatorState: true,
    includeFirebaseSources: ADMIN_ENABLE_FIREBASE_DIRECTORY_SCAN,
  });
  const totalUsers = rows.length;
  const emailVerifiedUsers = rows.filter((row) => row.email_verified === true || row.emailVerified === true || row.is_verified === true).length;
  const suspendedUsers = rows.filter((row) => row.suspended === true).length;
  const bannedUsers = rows.filter((row) => row.banned === true).length;
  const startMs = d.getTime();
  const newToday = rows.filter((row) => {
    const t = new Date(row.created_at || row.createdAt || 0).getTime();
    return Number.isFinite(t) && t >= startMs;
  }).length;
  const creatorRows = rows.filter((row) => row.creator === true || row.is_creator === true || row.creator_status === 'approved' || row.creatorStatus === 'approved');
  const creatorsTotal = creatorRows.length;
  let creatorsPstar = 0;
  let creatorsChannel = 0;
  for (const row of creatorRows) {
    const type = String(row.creator_type || row.creatorType || '').trim().toLowerCase();
    if (type === 'channel') creatorsChannel += 1;
    else creatorsPstar += 1;
  }

  return {
    totalUsers,
    emailVerifiedUsers,
    suspendedUsers,
    bannedUsers,
    newToday,
    creatorsTotal,
    creatorsPstar,
    creatorsChannel,
    firebaseOnlyUsers: counts.firebaseOnlyTotal,
    supabaseTotal: counts.supabaseTotal,
    firebaseAuthTotal: counts.firebaseAuthTotal,
    firestoreTotal: counts.firestoreTotal,
    rtdbTotal: counts.rtdbTotal,
    firebaseSourceTotal: counts.firebaseSourceTotal,
    mergedTotal: counts.mergedTotal,
    rawSourceTotal: counts.rawSourceTotal,
    deduplicatedTotal: counts.deduplicatedTotal,
    sourceCounts: counts,
  };
}

async function getSupabasePlatformCreatorCounts() {
  if (!isSupabaseAvailable() || !supabase) {
    return { total: 0, pstars: 0, channels: 0 };
  }

  let total = await safeCount(supabase.from('users').select('id', { count: 'exact', head: true }).eq('creator', true));
  let idQuery = supabase
    .from('users')
    .select('id')
    .eq('creator', true)
    .limit(PLATFORM_CREATOR_TYPE_SCAN_LIMIT);

  if (total === 0) {
    const approved = await safeCount(supabase.from('users').select('id', { count: 'exact', head: true }).eq('verified', 'approved'));
    if (approved > 0) {
      total = approved;
      idQuery = supabase
        .from('users')
        .select('id')
        .eq('verified', 'approved')
        .limit(PLATFORM_CREATOR_TYPE_SCAN_LIMIT);
    }
  }

  if (total <= 0) {
    return { total: 0, pstars: 0, channels: 0 };
  }

  const { data: userRows, error: userError } = await idQuery;
  if (userError || !Array.isArray(userRows) || userRows.length === 0) {
    return { total, pstars: total, channels: 0 };
  }

  const creatorUserIds = [...new Set(userRows.map((row) => row.id).filter(Boolean))];
  if (!creatorUserIds.length) {
    return { total, pstars: total, channels: 0 };
  }

  let typedRows = [];
  const CHUNK = 400;
  for (let i = 0; i < creatorUserIds.length; i += CHUNK) {
    const slice = creatorUserIds.slice(i, i + CHUNK);
    try {
      const { data, error } = await supabase
        .from('creators')
        .select('user_id, creator_type')
        .in('user_id', slice);
      if (!error && Array.isArray(data)) typedRows.push(...data);
    } catch {
      /* creators table may be unavailable during early setup */
    }
  }

  const typedByUserId = new Map();
  for (const row of typedRows) {
    if (!row?.user_id) continue;
    typedByUserId.set(row.user_id, String(row.creator_type || '').trim().toLowerCase());
  }

  let channels = 0;
  let pstars = 0;
  for (const userId of creatorUserIds) {
    const type = typedByUserId.get(userId);
    if (type === 'channel') channels += 1;
    else pstars += 1;
  }

  const scannedTotal = pstars + channels;
  if (total > scannedTotal) pstars += total - scannedTotal;
  return { total, pstars, channels };
}

export async function countCreatorApplicationsByStatus(status = 'pending') {
  const normalized = String(status || '').trim() || 'pending';
  if (!isSupabaseAvailable() || !supabase) return 0;
  const [legacy, current] = await Promise.all([
    safeCount(supabase.from('creator_applications').select('id', { count: 'exact', head: true }).eq('status', normalized)),
    safeCount(supabase.from('creators_main_application').select('id', { count: 'exact', head: true }).eq('status', normalized)),
  ]);
  return legacy + current;
}

export async function listUsersForAdminFromDirectory(query) {
  const { search = '', verifiedFilter = '' } = query;
  const statusFilter = query.statusFilter || query.status || '';
  const { page, limit, offset } = paginateAdmin(query.page, query.limit || query.pageSize || query.perPage);
  const searchTrim = String(search || '').trim().replace(/,/g, ' ').slice(0, 120);

  const includeFirebaseSources = query.includeFirebaseSources === true
    || query.includeFirebaseSources === 'true'
    || ADMIN_ENABLE_FIREBASE_DIRECTORY_SCAN;
  const { rows: mergedUsers, counts } = await collectMergedUserDirectoryRows({
    includeCreatorState: true,
    includeFirebaseSources,
  });
  let allUsers = applyAdminDirectoryFilters(mergedUsers, { searchTrim, statusFilter, verifiedFilter });

  allUsers.sort((a, b) => {
    const ad = new Date(a.created_at || a.createdAt || 0).getTime() || 0;
    const bd = new Date(b.created_at || b.createdAt || 0).getTime() || 0;
    if (bd !== ad) return bd - ad;
    return String(a.email || a.username || a.id).localeCompare(String(b.email || b.username || b.id));
  });

  const total = allUsers.length;
  const paginated = allUsers.slice(offset, offset + limit);
  const users = paginated.map(rowToAdminUserDto);
  const firebaseOnlyUsers = page === 1
    ? paginated
        .filter((row) => rowHasFirebaseSource(row) && !rowHasSource(row, 'supabase'))
        .map(rowToAdminUserDto)
    : [];
  const sourceCounts = {
    ...counts,
    filteredTotal: total,
  };
  return {
    source: includeFirebaseSources ? 'supabase+firebase_auth+firebase_firestore+firebase_rtdb' : 'supabase',
    users,
    total,
    mergedTotal: counts.mergedTotal,
    rawSourceTotal: counts.rawSourceTotal,
    supabaseTotal: counts.supabaseTotal,
    firebaseAuthTotal: counts.firebaseAuthTotal,
    firestoreTotal: counts.firestoreTotal,
    rtdbTotal: counts.rtdbTotal,
    firebaseOnlyTotal: counts.firebaseOnlyTotal,
    firebaseOnlyUsers,
    sourceCounts,
    counts: sourceCounts,
    page,
    limit,
  };
}

function isCreatorRowVerified(u) {
  return !!(u.verified && u.verified !== 'none' && u.verified !== 'rejected' && u.verified !== 'pending');
}

export async function listPlatformCreatorsFromDirectory(query) {
  const { search = '', verifiedFilter = '', typeFilter = '' } = query;
  const { page, limit, offset } = paginateAdmin(query.page, query.limit);
  const searchTrim = String(search || '').trim();

  if (!isSupabaseAvailable() || !supabase) {
    return { creators: [], total: 0, page, limit };
  }

  let typeUserIds = null;
  if (typeFilter === 'pstar' || typeFilter === 'channel') {
    const { data: idRows, error: tidErr } = await supabase
      .from('creators')
      .select('user_id')
      .eq('creator_type', typeFilter);
    if (tidErr) {
      if (markSupabaseUnavailable(tidErr, 'listPlatformCreatorsFromDirectory')) {
        return { creators: [], total: 0, page, limit, error: 'Supabase temporarily unreachable' };
      }
      return { creators: [], total: 0, page, limit, error: tidErr.message };
    }
    typeUserIds = [...new Set((idRows || []).map((r) => r.user_id).filter(Boolean))];
    if (typeUserIds.length === 0) {
      return { creators: [], total: 0, page, limit };
    }
  }

  await usersFacetSelectColumns();

  let countQ = supabase.from('users').select('*', { count: 'exact', head: true }).eq('creator', true);
  const searchOr = userSearchOrFilter(searchTrim);
  if (searchOr) countQ = countQ.or(searchOr);
  if (typeUserIds) countQ = countQ.in('id', typeUserIds);

  const { count: totalCount, error: countErr } = await countQ;
  if (countErr) {
    if (markSupabaseUnavailable(countErr, 'listPlatformCreatorsFromDirectory')) {
      return { creators: [], total: 0, page, limit, error: 'Supabase temporarily unreachable' };
    }
    return { creators: [], total: 0, page, limit, error: countErr.message };
  }

  const total = totalCount || 0;
  if (total === 0 || offset >= total) {
    return { creators: [], total, page, limit };
  }

  let q = supabase.from('users').select('*').eq('creator', true);
  if (searchOr) q = q.or(searchOr);
  if (typeUserIds) q = q.in('id', typeUserIds);
  q = q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

  const { data: userRows, error } = await q;
  if (error) {
    if (markSupabaseUnavailable(error, 'listPlatformCreatorsFromDirectory')) {
      return { creators: [], total: 0, page, limit, error: 'Supabase temporarily unreachable' };
    }
    return { creators: [], total: 0, page, limit, error: error.message };
  }
  if (!userRows?.length) {
    return { creators: [], total, page, limit };
  }

  const userIds = userRows.map((u) => u.id).filter(Boolean);
  const { data: creatorRows } = await supabase
    .from('creators')
    .select('id, user_id, display_name, creator_type, created_at')
    .in('user_id', userIds);
  const creatorByUserId = Object.fromEntries((creatorRows || []).map((c) => [c.user_id, c]));

  let creators = userRows.map((u) => {
    const c = creatorByUserId[u.id];
    const resolvedType = c?.creator_type === 'channel' ? 'channel' : 'pstar';
    return {
      id: c?.id || u.id,
      user_id: u.id,
      username: u.username || u.id,
      display_name: c?.display_name || u.display_name || u.full_name || u.username || u.id,
      creator_type: resolvedType,
      email: u.email || '',
      avatar_url: u.avatar_url || u.avatar || null,
      status: u.banned ? 'banned' : u.suspended ? 'suspended' : 'active',
      is_verified: isCreatorRowVerified(u),
      followers: Number(u.followers) || 0,
      created_at: c?.created_at || u.created_at || new Date().toISOString(),
    };
  });

  if (verifiedFilter === 'true') {
    creators = creators.filter((c) => c.is_verified);
  }

  const enriched = await enrichUsersFromFirebase(creators);
  return { creators: enriched, total, page, limit };
}

export async function fetchUserRowForAdminById(id) {
  const rows = [];
  if (isSupabaseAvailable() && supabase) {
    try {
      const { data: raw, error } = await supabase.from('users').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      if (!error && raw) rows.push({ ...raw, source: 'supabase', supabase_user_id: raw.id });
    } catch (err) {
      warnSupabaseDirectoryFallback('fetchUserRowForAdminById', err);
    }
  }

  const rtdb = getFirebaseRtdb();
  if (rtdb) {
    try {
      const snap = await withTimeout(rtdb.ref(`users/${id}`).once('value'), 'Firebase RTDB user lookup');
      const val = snap.val();
      if (val) rows.push(rtdbUserToRow(id, val));
    } catch {
      /* ignore */
    }
  }

  const db = getFirebaseDb();
  if (db) {
    try {
      const snap = await withTimeout(db.collection('users').doc(id).get(), 'Firestore user lookup');
      if (snap.exists) rows.push(firestoreUserDocToRow(id, snap.data() || {}));
    } catch {
      /* ignore */
    }
  }

  const auth = getFirebaseAuth();
  if (auth) {
    try {
      const record = await withTimeout(auth.getUser(id), 'Firebase Auth getUser');
      if (record) rows.push(firebaseAuthUserToRow(record));
    } catch {
      /* ignore */
    }
  }

  const merged = mergeUserRowsById(rows);
  const withCreatorState = await applyCreatorState(merged);
  const row = withCreatorState[0] || null;
  if (row) {
    const enriched = (await enrichUsersFromFirebase([row]))[0];
    return { row: enriched, source: 'merged' };
  }
  return { row: null, source: 'missing' };
}
