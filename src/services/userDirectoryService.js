import { supabase, isConfigured } from '../config/supabase.js';
import { getFirebaseAuth, getFirebaseDb, getFirebaseRtdb } from '../config/firebase.js';

export function paginateAdmin(page, limit) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
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
  return {
    id: u.id,
    username,
    fullName,
    email,
    avatar,
    verified: !!(u.email_verified === true || u.emailVerified === true),
    role: u.role || 'user',
    createdAt: u.created_at || u.createdAt || null,
    updatedAt: u.updated_at || u.updatedAt || u.created_at || u.createdAt || null,
    isCreator: !!(u.creator || u.is_creator),
    creatorStatus: typeof u.verified === 'string' ? u.verified : (u.creator_status || 'none'),
    accountStatus: u.banned ? 'banned' : u.suspended ? 'suspended' : 'active',
    followers: Number(u.followers) || 0,
    following: Number(u.following) || 0,
    coinBalance: Number(u.coin_balance ?? u.coinBalance ?? u.balance) || 0,
  };
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
    created_at: o.created_at || o.createdAt,
    updated_at: o.updated_at || o.updatedAt,
    banned: o.banned,
    suspended: o.suspended,
  };
}

const MAX_RTDB_USER_SCAN = 8000;

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
  const rtdb = getFirebaseRtdb();
  if (!rtdb || !isConfigured() || !supabase) return 0;
  try {
    const snap = await rtdb.ref('users').once('value');
    const val = snap.val();
    if (!val || typeof val !== 'object') return 0;
    const ids = Object.keys(val).filter(Boolean);
    if (ids.length > MAX_RTDB_USER_SCAN) {
      console.warn('[userDirectory] RTDB user scan capped for firebase-only count');
    }
    const capped = ids.slice(0, MAX_RTDB_USER_SCAN);
    let missing = 0;
    const CHUNK = 300;
    for (let i = 0; i < capped.length; i += CHUNK) {
      const slice = capped.slice(i, i + CHUNK);
      const { data } = await supabase.from('users').select('id').in('id', slice);
      const have = new Set((data || []).map((r) => r.id));
      for (const id of slice) {
        if (!have.has(id)) missing += 1;
      }
    }
    return missing + Math.max(0, ids.length - capped.length);
  } catch (e) {
    console.warn('[userDirectory] countFirebaseOnlyUsers', e?.message || e);
    return 0;
  }
}

export async function listFirebaseOnlyUsersForAdmin(query) {
  const { search = '', statusFilter = '', verifiedFilter = '' } = query;
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 50));
  const searchTrim = String(search || '').trim().replace(/,/g, ' ').slice(0, 120);
  const rtdb = getFirebaseRtdb();
  if (!rtdb || !isConfigured() || !supabase) {
    return { users: [], total: 0 };
  }
  try {
    const snap = await rtdb.ref('users').once('value');
    const val = snap.val();
    if (!val || typeof val !== 'object') return { users: [], total: 0 };
    const ids = Object.keys(val).filter(Boolean);
    if (ids.length > MAX_RTDB_USER_SCAN) {
      console.warn('[userDirectory] RTDB user scan capped for firebase-only list');
    }
    const capped = ids.slice(0, MAX_RTDB_USER_SCAN);
    const missingIds = [];
    const CHUNK = 300;
    for (let i = 0; i < capped.length; i += CHUNK) {
      const slice = capped.slice(i, i + CHUNK);
      const { data } = await supabase.from('users').select('id').in('id', slice);
      const have = new Set((data || []).map((r) => r.id));
      for (const id of slice) {
        if (!have.has(id)) missingIds.push(id);
      }
    }
    let rows = missingIds.map((id) => rtdbUserToRow(id, typeof val[id] === 'object' && val[id] !== null ? val[id] : {}));
    rows = applyAdminDirectoryFilters(rows, { searchTrim, statusFilter, verifiedFilter });
    rows.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
    const total = rows.length;
    const sliced = rows.slice(0, limit);
    const merged = await enrichUsersFromFirebase(sliced);
    const users = merged.map(rowToAdminUserDto);
    return { users, total };
  } catch (e) {
    console.warn('[userDirectory] listFirebaseOnlyUsersForAdmin', e?.message || e);
    return { users: [], total: 0 };
  }
}

export async function buildAdminUserFacetsByIds(userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return {};
  const rows = [];
  if (isConfigured() && supabase) {
    const CHUNK = 200;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const { data } = await supabase
        .from('users')
        .select('id, username, display_name, full_name, email, avatar, avatar_url, email_verified')
        .in('id', slice);
      for (const r of data || []) rows.push(r);
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
      const resp = await auth.getUsers(batch.map((uid) => ({ uid })));
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
  d.setHours(0, 0, 0, 0);
  const todayIso = d.toISOString();

  if (!isConfigured() || !supabase) {
    return {
      totalUsers: 0,
      emailVerifiedUsers: 0,
      suspendedUsers: 0,
      bannedUsers: 0,
      newToday: 0,
      creatorsTotal: 0,
      creatorsPstar: 0,
      creatorsChannel: 0,
      firebaseOnlyUsers: 0,
    };
  }

  const [
    totalUsers,
    emailVerifiedUsers,
    suspendedUsers,
    bannedUsers,
    newToday,
    creatorsTotal,
  ] = await Promise.all([
    safeCount(supabase.from('users').select('*', { count: 'exact', head: true })),
    safeCount(supabase.from('users').select('*', { count: 'exact', head: true }).eq('email_verified', true)),
    safeCount(supabase.from('users').select('*', { count: 'exact', head: true }).eq('suspended', true)),
    safeCount(supabase.from('users').select('*', { count: 'exact', head: true }).eq('banned', true)),
    safeCount(supabase.from('users').select('*', { count: 'exact', head: true }).gte('created_at', todayIso)),
    safeCount(supabase.from('users').select('*', { count: 'exact', head: true }).eq('creator', true)),
  ]);

  let creatorsPstar = 0;
  let creatorsChannel = 0;
  const { data: creatorUserRows } = await supabase.from('users').select('id').eq('creator', true);
  const creatorUserIds = (creatorUserRows || []).map((r) => r.id).filter(Boolean);
  const CHUNK = 400;
  for (let i = 0; i < creatorUserIds.length; i += CHUNK) {
    const slice = creatorUserIds.slice(i, i + CHUNK);
    const { data: typeRows } = await supabase.from('creators').select('creator_type').in('user_id', slice);
    for (const row of typeRows || []) {
      if (row.creator_type === 'channel') creatorsChannel += 1;
      else creatorsPstar += 1;
    }
  }
  const typedTotal = creatorsPstar + creatorsChannel;
  creatorsPstar += Math.max(0, creatorsTotal - typedTotal);

  const firebaseOnlyUsers = await countFirebaseOnlyUsers();

  return {
    totalUsers,
    emailVerifiedUsers,
    suspendedUsers,
    bannedUsers,
    newToday,
    creatorsTotal,
    creatorsPstar,
    creatorsChannel,
    firebaseOnlyUsers,
  };
}

export async function listUsersForAdminFromDirectory(query) {
  const { search = '', statusFilter = '', verifiedFilter = '' } = query;
  const { page, limit, offset } = paginateAdmin(query.page, query.limit);
  const searchTrim = String(search || '').trim().replace(/,/g, ' ').slice(0, 120);
  const orFilter = searchTrim
    ? `username.ilike.%${searchTrim}%,email.ilike.%${searchTrim}%,display_name.ilike.%${searchTrim}%,full_name.ilike.%${searchTrim}%`
    : null;

  if (!isConfigured() || !supabase) {
    return { source: 'none', users: [], total: 0, page, limit };
  }

  let countQ = supabase.from('users').select('*', { count: 'exact', head: true });
  if (statusFilter === 'creator') countQ = countQ.eq('creator', true);
  if (verifiedFilter === 'true') countQ = countQ.eq('email_verified', true);
  if (orFilter) countQ = countQ.or(orFilter);

  const { count, error: countErr } = await countQ;

  if (!countErr) {
    const supabaseTotal = count || 0;
    let firebaseOnlyUsers = [];
    let firebaseOnlyTotal = 0;
    if (page === 1) {
      const fb = await listFirebaseOnlyUsersForAdmin({
        ...query,
        limit: Math.min(50, limit),
      });
      firebaseOnlyUsers = fb.users;
      firebaseOnlyTotal = fb.total;
    }

    if (supabaseTotal === 0 || offset >= supabaseTotal) {
      if (firebaseOnlyUsers.length) {
        return {
          source: 'supabase+firebase',
          users: firebaseOnlyUsers,
          total: firebaseOnlyTotal,
          supabaseTotal: 0,
          firebaseOnlyTotal,
          firebaseOnlyUsers,
          page,
          limit,
        };
      }
      return { source: 'supabase', users: [], total: 0, supabaseTotal: 0, firebaseOnlyTotal: 0, firebaseOnlyUsers: [], page, limit };
    }

    let q = supabase.from('users').select('*');
    if (statusFilter === 'creator') q = q.eq('creator', true);
    if (verifiedFilter === 'true') q = q.eq('email_verified', true);
    if (orFilter) q = q.or(orFilter);
    q = q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

    const { data, error } = await q;
    if (error) {
      return { source: 'supabase_error', users: [], total: 0, page, limit, error };
    }

    const merged = await enrichUsersFromFirebase(data || []);
    const users = merged.map(rowToAdminUserDto);
    return {
      source: 'supabase+firebase',
      users,
      total: supabaseTotal,
      supabaseTotal,
      firebaseOnlyTotal,
      firebaseOnlyUsers,
      page,
      limit,
    };
  }

  const rtdb = getFirebaseRtdb();
  if (!rtdb) {
    return { source: 'rtdb_missing', users: [], total: 0, page, limit };
  }

  const snap = await rtdb.ref('users').once('value');
  const val = snap.val();
  if (!val || typeof val !== 'object') {
    return { source: 'rtdb', users: [], total: 0, page, limit };
  }

  let allUsers = Object.entries(val).map(([id, u]) =>
    rtdbUserToRow(id, typeof u === 'object' && u !== null ? u : {})
  );

  allUsers = applyAdminDirectoryFilters(allUsers, { searchTrim, statusFilter, verifiedFilter });

  allUsers.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());

  const total = allUsers.length;
  const paginated = allUsers.slice(offset, offset + limit);
  const merged = await enrichUsersFromFirebase(paginated);
  const users = merged.map(rowToAdminUserDto);
  return {
    source: 'rtdb',
    users,
    total,
    supabaseTotal: 0,
    firebaseOnlyTotal: total,
    firebaseOnlyUsers: page === 1 ? users : [],
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

  if (!isConfigured() || !supabase) {
    return { creators: [], total: 0, page, limit };
  }

  let typeUserIds = null;
  if (typeFilter === 'pstar' || typeFilter === 'channel') {
    const { data: idRows, error: tidErr } = await supabase
      .from('creators')
      .select('user_id')
      .eq('creator_type', typeFilter);
    if (tidErr) {
      return { creators: [], total: 0, page, limit, error: tidErr.message };
    }
    typeUserIds = [...new Set((idRows || []).map((r) => r.user_id).filter(Boolean))];
    if (typeUserIds.length === 0) {
      return { creators: [], total: 0, page, limit };
    }
  }

  let countQ = supabase.from('users').select('*', { count: 'exact', head: true }).eq('creator', true);
  if (searchTrim) {
    countQ = countQ.or(
      `username.ilike.%${searchTrim}%,email.ilike.%${searchTrim}%,display_name.ilike.%${searchTrim}%,full_name.ilike.%${searchTrim}%`
    );
  }
  if (typeUserIds) countQ = countQ.in('id', typeUserIds);

  const { count: totalCount, error: countErr } = await countQ;
  if (countErr) {
    return { creators: [], total: 0, page, limit, error: countErr.message };
  }

  const total = totalCount || 0;
  if (total === 0 || offset >= total) {
    return { creators: [], total, page, limit };
  }

  let q = supabase.from('users').select('*').eq('creator', true);
  if (searchTrim) {
    q = q.or(
      `username.ilike.%${searchTrim}%,email.ilike.%${searchTrim}%,display_name.ilike.%${searchTrim}%,full_name.ilike.%${searchTrim}%`
    );
  }
  if (typeUserIds) q = q.in('id', typeUserIds);
  q = q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

  const { data: userRows, error } = await q;
  if (error) {
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
  if (!isConfigured() || !supabase) {
    return { row: null, source: 'none' };
  }
  const { data: raw, error } = await supabase.from('users').select('*').eq('id', id).maybeSingle();
  if (!error && raw) {
    const mergedRow = (await enrichUsersFromFirebase([raw]))[0];
    return { row: mergedRow, source: 'supabase' };
  }

  const rtdb = getFirebaseRtdb();
  if (rtdb) {
    const snap = await rtdb.ref(`users/${id}`).once('value');
    const val = snap.val();
    if (val) {
      const mergedRow = (await enrichUsersFromFirebase([rtdbUserToRow(id, val)]))[0];
      return { row: mergedRow, source: 'rtdb' };
    }
  }
  return { row: null, source: 'missing' };
}
