import { randomBytes } from 'crypto';
import sanitizeHtml from 'sanitize-html';
import { supabase } from '../config/supabase.js';
import { getFirebaseAuth, getFirebaseDb, getFirebaseRtdb } from '../config/firebase.js';
import { decryptApplicationData, encryptApplicationData } from '../config/encrypt.js';
import { sendAccountDeletionEmail, sendApplicationDecisionEmail } from '../services/emailService.js';
import { updateUserCreatorStatus } from '../config/dbFallback.js';
import { upsertCreator } from './creator.controller.js';
import {
  enrichUsersFromFirebase,
  rowToAdminUserDto,
  paginateAdmin,
  listUsersForAdminFromDirectory,
  listPlatformCreatorsFromDirectory,
  fetchUserRowForAdminById,
  buildAdminUserFacetsByIds,
} from '../services/userDirectoryService.js';
import { logAction as writeAuditAction } from '../services/adminAudit.service.js';
import { setCoinBalance } from '../services/coinWallet.service.js';

function detectMissingFields(appData) {
  const missing = [];
  if (!appData.phone) missing.push({ field: 'phone', label: 'Phone Number' });
  if (!appData.bio) missing.push({ field: 'bio', label: 'Bio / About You' });
  if (!appData.idType) missing.push({ field: 'idType', label: 'ID Type' });
  if (!appData.idNumber) missing.push({ field: 'idNumber', label: 'ID Number' });
  const attachments = Array.isArray(appData.attachments) ? appData.attachments : [];
  if (!attachments.some(a => a.contentType?.startsWith('image/'))) {
    missing.push({ field: 'idImages', label: 'ID Document Photos' });
  }
  if (!attachments.some(a => a.contentType?.startsWith('video/'))) {
    missing.push({ field: 'verificationVideo', label: 'Liveness Verification Video' });
  }
  const socialKeys = ['instagramUrl', 'xUrl', 'tiktokUrl', 'youtubeUrl', 'websiteUrl'];
  if (!socialKeys.some(k => appData[k])) {
    missing.push({ field: 'socialLinks', label: 'At least one Social Media Link' });
  }
  return missing;
}

function generateUpdateToken() {
  return randomBytes(32).toString('hex');
}

function isMissingTable(err) {
  return err?.code === '42P01' || err?.code === 'PGRST200' ||
    (typeof err?.message === 'string' && err.message.includes('schema cache'));
}

async function logAction(adminId, adminName, action, targetType, targetId, details = {}) {
  await writeAuditAction(adminId, adminName, action, targetType, targetId, details);
}

function sanitizeAdminReason(value) {
  return sanitizeHtml(String(value || ''), {
    allowedTags: [],
    allowedAttributes: {},
  }).replace(/\s+/g, ' ').trim().slice(0, 2000);
}

function adminCanDeleteUsers(admin) {
  if (admin?.is_super_admin) return true;
  const permissions = Array.isArray(admin?.permissions) ? admin.permissions : [];
  return permissions.includes('/') || permissions.includes('/users');
}

function adminCanModerateCreators(admin) {
  if (admin?.is_super_admin) return true;
  const permissions = Array.isArray(admin?.permissions) ? admin.permissions : [];
  return permissions.includes('/') || permissions.includes('/creator-applications') || permissions.includes('/creators') || permissions.includes('/users');
}

function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function normalizeModerationReason(value, fallback = '') {
  const clean = sanitizeAdminReason(value);
  return clean || fallback;
}

function creatorTypeFromApplicationData(appData = {}) {
  return appData.creator_type === 'channel' || appData.creatorType === 'channel' ? 'channel' : 'pstar';
}

function displayNameFromApplicationData(appData = {}, fallback = 'Creator') {
  return (
    appData.displayName ||
    appData.stageName ||
    [appData.firstName, appData.lastName].filter(Boolean).join(' ') ||
    appData.fullName ||
    fallback
  );
}

function isColumnMissingError(error) {
  return error?.code === '42703' || String(error?.message || '').toLowerCase().includes('column');
}

async function updateSupabaseUserCreatorState(userId, payload) {
  if (!userId) return false;
  const { error } = await supabase.from('users').update(payload).eq('id', userId);
  if (!error) return true;
  if (!isColumnMissingError(error)) throw error;

  const fallback = {};
  for (const key of ['creator', 'verified']) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) fallback[key] = payload[key];
  }
  if (!Object.keys(fallback).length) return false;
  const retry = await supabase.from('users').update(fallback).eq('id', userId);
  if (retry.error && !isColumnMissingError(retry.error)) throw retry.error;
  return !retry.error;
}

async function upsertCreatorProfileForApproval(userId, appData, applicationId) {
  const creatorType = creatorTypeFromApplicationData(appData);
  const payload = {
    display_name: displayNameFromApplicationData(appData, userId),
    bio: appData.bio || appData.content || '',
    creator_type: creatorType,
    active: true,
    status: 'active',
    application_id: applicationId,
    updated_at: new Date().toISOString(),
  };

  try {
    return await upsertCreator(userId, payload);
  } catch (err) {
    if (!isColumnMissingError(err)) throw err;
    const fallback = {
      display_name: payload.display_name,
      bio: payload.bio,
      creator_type: payload.creator_type,
    };
    return upsertCreator(userId, fallback);
  }
}

async function deactivateCreatorProfile(userId, status = 'removed') {
  if (!userId) return;
  const payload = { active: false, status, updated_at: new Date().toISOString() };
  const { error } = await supabase.from('creators').update(payload).eq('user_id', userId);
  if (error && !isIgnorableCleanupError(error) && !isColumnMissingError(error)) throw error;
}

async function setCreatorApplicationBan(userId, ban) {
  const normalizedBan = ban?.banned
    ? {
        banned: true,
        reason: sanitizeAdminReason(ban.reason),
        adminId: ban.adminId || null,
        expiresAt: ban.expiresAt || null,
        createdAt: new Date().toISOString(),
      }
    : { banned: false, reason: '', adminId: null, expiresAt: null, clearedAt: new Date().toISOString() };

  await updateSupabaseUserCreatorState(userId, { creator_application_ban: normalizedBan });

  const firestoreDb = getFirebaseDb();
  if (firestoreDb) {
    await firestoreDb.collection('users').doc(userId).set({ creatorApplicationBan: normalizedBan }, { merge: true }).catch(() => {});
  }
  const rtdb = getFirebaseRtdb();
  if (rtdb) {
    await rtdb.ref(`users/${userId}/creatorApplicationBan`).set(normalizedBan).catch(() => {});
  }
  return normalizedBan;
}

async function syncCreatorLifecycle(userId, { status, appData = {}, applicationId = null, ban = null }) {
  if (!userId) return {};
  const approved = status === 'approved';
  const pending = status === 'pending' || status === 'info_requested';
  const creatorStatus = approved ? 'approved' : pending ? 'pending' : status === 'banned' ? 'banned' : 'rejected';
  const role = approved ? 'creator' : 'user';
  const userPayload = {
    creator: approved,
    verified: creatorStatus,
    role,
    updated_at: new Date().toISOString(),
  };
  if (ban) userPayload.creator_application_ban = ban;

  let supabaseUpdated = false;
  try {
    supabaseUpdated = await updateSupabaseUserCreatorState(userId, userPayload);
  } catch (err) {
    console.warn('[creatorLifecycle] Supabase user sync failed:', err?.message || err);
  }

  const firebasePayload = {
    creator: approved,
    creatorStatus,
    verified: creatorStatus,
    role,
    updatedAt: new Date().toISOString(),
    ...(ban ? { creatorApplicationBan: ban } : {}),
  };

  const firestoreDb = getFirebaseDb();
  if (firestoreDb) {
    await firestoreDb.collection('users').doc(userId).set(firebasePayload, { merge: true }).catch((err) => {
      console.warn('[creatorLifecycle] Firestore sync failed:', err?.message || err);
    });
  }

  const rtdb = getFirebaseRtdb();
  if (rtdb) {
    await rtdb.ref(`users/${userId}`).update(firebasePayload).catch((err) => {
      console.warn('[creatorLifecycle] RTDB sync failed:', err?.message || err);
    });
  }

  const auth = getFirebaseAuth();
  if (auth) {
    try {
      const existing = await auth.getUser(userId);
      await auth.setCustomUserClaims(userId, {
        ...(existing.customClaims || {}),
        role,
        creator: approved,
        creatorStatus,
      });
    } catch (err) {
      if (err?.code !== 'auth/user-not-found') {
        console.warn('[creatorLifecycle] Firebase custom claims sync failed:', err?.message || err);
      }
    }
  }

  if (approved) {
    await upsertCreatorProfileForApproval(userId, appData, applicationId);
  } else if (status === 'rejected' || status === 'banned') {
    await deactivateCreatorProfile(userId, status === 'banned' ? 'banned' : 'removed');
  }

  return { supabaseUpdated, creatorStatus, role };
}

async function fetchApplicationRecord(id) {
  const { data, error } = await supabase.from('creator_applications').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function updateApplicationLifecycle(id, payload) {
  const required = { status: payload.status };
  const review = {
    status: payload.status,
    review_reason: payload.review_reason,
    reviewed_at: payload.reviewed_at,
    reviewed_by: payload.reviewed_by,
  };

  const { error } = await supabase.from('creator_applications').update(review).eq('id', id);
  if (error) {
    if (!isColumnMissingError(error)) throw error;
    const retry = await supabase.from('creator_applications').update(required).eq('id', id);
    if (retry.error && !isMissingTable(retry.error)) throw retry.error;
  }

  const optional = { ...payload };
  delete optional.status;
  delete optional.review_reason;
  delete optional.reviewed_at;
  delete optional.reviewed_by;
  if (Object.keys(optional).length) {
    const extra = await supabase.from('creator_applications').update(optional).eq('id', id);
    if (extra.error && !isColumnMissingError(extra.error) && !isMissingTable(extra.error)) throw extra.error;
  }
}

function isIgnorableCleanupError(error) {
  const code = error?.code;
  const message = String(error?.message || '').toLowerCase();
  return (
    code === '42P01' ||
    code === '42703' ||
    code === 'PGRST200' ||
    code === 'PGRST204' ||
    message.includes('schema cache') ||
    message.includes('does not exist') ||
    message.includes('could not find')
  );
}

function parseSupabaseStoragePath(url) {
  if (!url || typeof url !== 'string' || !url.includes('/storage/v1/object/')) return null;
  try {
    const u = new URL(url);
    const match = u.pathname.match(/\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+)$/);
    if (!match) return null;
    return {
      bucket: match[1],
      path: decodeURIComponent(match[2].replace(/\+/g, ' ')),
    };
  } catch {
    return null;
  }
}

function uniqueValues(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

async function collectUserStorageTargets(userIds) {
  const targets = [];
  const ids = uniqueValues(userIds);
  if (!ids.length) return targets;

  try {
    const { data } = await supabase.from('media').select('bucket, path, url').in('user_id', ids);
    for (const row of data || []) {
      if (row.bucket && row.path) targets.push({ bucket: row.bucket, path: row.path });
      const parsed = parseSupabaseStoragePath(row.url);
      if (parsed) targets.push(parsed);
    }
  } catch (_) {}

  try {
    const { data } = await supabase.from('tiktok_videos').select('*').in('user_id', ids);
    for (const row of data || []) {
      for (const value of Object.values(row || {})) {
        const parsed = parseSupabaseStoragePath(value);
        if (parsed) targets.push(parsed);
      }
    }
  } catch (_) {}

  const seen = new Set();
  return targets.filter((target) => {
    if (!target?.bucket || !target?.path) return false;
    const key = `${target.bucket}/${target.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function removeStorageTargets(targets) {
  const byBucket = new Map();
  for (const target of targets || []) {
    if (!byBucket.has(target.bucket)) byBucket.set(target.bucket, []);
    byBucket.get(target.bucket).push(target.path);
  }
  let removed = 0;
  const errors = [];
  for (const [bucket, paths] of byBucket.entries()) {
    try {
      const { data, error } = await supabase.storage.from(bucket).remove(paths);
      if (error) {
        errors.push({ bucket, message: error.message });
      } else {
        removed += Array.isArray(data) ? data.length : paths.length;
      }
    } catch (err) {
      errors.push({ bucket, message: err?.message || String(err) });
    }
  }
  return { removed, errors };
}

async function deleteSupabaseRows(table, column, values, { required = false, cleanup = [] } = {}) {
  const ids = uniqueValues(Array.isArray(values) ? values : [values]);
  if (!ids.length) return;
  try {
    const query = ids.length === 1
      ? supabase.from(table).delete().eq(column, ids[0])
      : supabase.from(table).delete().in(column, ids);
    const { error } = await query;
    if (error) {
      if (required || !isIgnorableCleanupError(error)) throw error;
      cleanup.push({ table, column, skipped: true, reason: error.message });
    } else {
      cleanup.push({ table, column, ok: true });
    }
  } catch (err) {
    if (required) throw err;
    if (!isIgnorableCleanupError(err)) {
      cleanup.push({ table, column, ok: false, reason: err?.message || String(err) });
    }
  }
}

async function cleanupSupabaseUserData(userIds) {
  const ids = uniqueValues(userIds);
  const cleanup = [];
  if (!ids.length) return cleanup;

  const storageTargets = await collectUserStorageTargets(ids);
  const storage = await removeStorageTargets(storageTargets);
  cleanup.push({ storageRemoved: storage.removed, storageErrors: storage.errors });

  await deleteSupabaseRows('video_ad_impressions', 'user_id', ids, { cleanup });
  await deleteSupabaseRows('video_play_history', 'user_id', ids, { cleanup });
  await deleteSupabaseRows('tiktok_video_views', 'user_id', ids, { cleanup });
  await deleteSupabaseRows('tiktok_video_likes', 'user_id', ids, { cleanup });
  await deleteSupabaseRows('tiktok_video_comments', 'user_id', ids, { cleanup });
  await deleteSupabaseRows('video_purchases', 'user_id', ids, { cleanup });
  await deleteSupabaseRows('live_viewers', 'user_id', ids, { cleanup });
  await deleteSupabaseRows('live_comments', 'user_id', ids, { cleanup });
  await deleteSupabaseRows('live_gifts', 'sender_id', ids, { cleanup });
  await deleteSupabaseRows('stream_donations', 'sender_id', ids, { cleanup });
  await deleteSupabaseRows('stream_donations', 'creator_id', ids, { cleanup });
  await deleteSupabaseRows('messages', 'sender_id', ids, { cleanup });
  await deleteSupabaseRows('messages', 'receiver_id', ids, { cleanup });
  await deleteSupabaseRows('messages', 'creator_id', ids, { cleanup });
  await deleteSupabaseRows('conversations', 'creator_id', ids, { cleanup });
  for (const id of ids) {
    try {
      const { error } = await supabase.from('conversations').delete().contains('participant_ids', [id]);
      if (error && !isIgnorableCleanupError(error)) cleanup.push({ table: 'conversations', column: 'participant_ids', ok: false, reason: error.message });
    } catch (err) {
      if (!isIgnorableCleanupError(err)) cleanup.push({ table: 'conversations', column: 'participant_ids', ok: false, reason: err?.message || String(err) });
    }
  }
  await deleteSupabaseRows('user_memberships', 'user_id', ids, { cleanup });
  await deleteSupabaseRows('token_transactions', 'user_id', ids, { cleanup });
  await deleteSupabaseRows('creator_payout_requests', 'creator_id', ids, { cleanup });
  await deleteSupabaseRows('creator_earnings', 'creator_id', ids, { cleanup });
  await deleteSupabaseRows('transactions', 'owner_id', ids, { cleanup });
  await deleteSupabaseRows('wallets', 'owner_id', ids, { cleanup });
  await deleteSupabaseRows('ad_campaigns', 'user_id', ids, { cleanup });
  await deleteSupabaseRows('live_streams', 'user_id', ids, { cleanup });
  await deleteSupabaseRows('lives', 'host_id', ids, { cleanup });
  await deleteSupabaseRows('streams', 'creator_id', ids, { cleanup });
  await deleteSupabaseRows('media', 'user_id', ids, { cleanup });
  await deleteSupabaseRows('tiktok_videos', 'user_id', ids, { cleanup });
  await deleteSupabaseRows('creator_applications', 'user_id', ids, { cleanup });
  await deleteSupabaseRows('creators', 'user_id', ids, { cleanup });
  await deleteSupabaseRows('email_verification_tokens', 'user_id', ids, { cleanup });
  await deleteSupabaseRows('users', 'id', ids, { required: true, cleanup });
  return cleanup;
}

async function cleanupFirebaseUserData(userIds) {
  const ids = uniqueValues(userIds);
  const result = { firestoreDeleted: 0, rtdbDeleted: 0, authDeleted: 0, errors: [] };
  const firestoreDb = getFirebaseDb();
  const rtdb = getFirebaseRtdb();
  const auth = getFirebaseAuth();

  for (const id of ids) {
    if (firestoreDb) {
      try {
        await firestoreDb.collection('users').doc(id).delete();
        await firestoreDb.collection('creatorApplications').doc(id).delete().catch(() => {});
        result.firestoreDeleted += 1;
      } catch (err) {
        result.errors.push({ source: 'firestore', id, message: err?.message || String(err) });
      }
    }

    if (rtdb) {
      try {
        await Promise.all([
          rtdb.ref(`users/${id}`).remove(),
          rtdb.ref(`creators/${id}`).remove(),
          rtdb.ref(`creator_applications/${id}`).remove(),
        ]);
        result.rtdbDeleted += 1;
      } catch (err) {
        result.errors.push({ source: 'rtdb', id, message: err?.message || String(err) });
      }
    }

    if (auth) {
      try {
        await auth.revokeRefreshTokens(id).catch(() => {});
        await auth.deleteUser(id);
        result.authDeleted += 1;
      } catch (err) {
        if (err?.code !== 'auth/user-not-found') {
          result.errors.push({ source: 'firebase_auth', id, message: err?.message || String(err) });
        }
      }
    }
  }
  return result;
}

// ── GET /api/admin/users ──────────────────────────────────────────────────────

export async function getUsers(req, res) {
  try {
    const result = await listUsersForAdminFromDirectory(req.query);
    if (result.error) {
      return res.status(500).json({ message: typeof result.error === 'string' ? result.error : result.error?.message || 'Query failed' });
    }
    return res.json({
      users: result.users,
      data: result.users,
      total: result.total,
      totalUsers: result.total,
      page: result.page,
      limit: result.limit,
      mergedTotal: result.mergedTotal,
      rawSourceTotal: result.rawSourceTotal,
      supabaseTotal: result.supabaseTotal,
      firebaseAuthTotal: result.firebaseAuthTotal,
      firestoreTotal: result.firestoreTotal,
      rtdbTotal: result.rtdbTotal,
      firebaseOnlyTotal: result.firebaseOnlyTotal,
      firebaseOnlyUsers: result.firebaseOnlyUsers,
      sourceCounts: result.sourceCounts || result.counts || null,
      dataSource: result.source,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/users/:id ──────────────────────────────────────────────────

export async function getUserById(req, res) {
  try {
    const { id } = req.params;
    const { row: mergedRow } = await fetchUserRowForAdminById(id);
    const user = mergedRow ? rowToAdminUserDto(mergedRow) : null;

    if (!user) return res.status(404).json({ message: 'User not found.' });

    // Membership record
    const { data: membership } = await supabase
      .from('user_memberships')
      .select('plan_id, amount_paid_usd, status, started_at, expires_at')
      .eq('user_id', id)
      .eq('status', 'active')
      .maybeSingle();

    // Creator earnings if creator
    let earnings = null;
    if (user.isCreator) {
      const { data: earns } = await supabase
        .from('creator_earnings')
        .select('amount_usd')
        .eq('creator_id', id);
      earnings = (earns || []).reduce((s, r) => s + (Number(r.amount_usd) || 0), 0);
    }

    // Admin action history
    const { data: history } = await supabase
      .from('admin_audit_logs')
      .select('admin_name, action, details, created_at')
      .eq('target_id', id)
      .order('created_at', { ascending: false })
      .limit(10);

    return res.json({ user, membership, earnings, adminHistory: history || [] });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── PUT /api/admin/users/:id/status ──────────────────────────────────────────

export async function updateUserStatus(req, res) {
  try {
    const { id } = req.params;
    const { status, reason = '' } = req.body;
    if (!['active', 'suspended', 'banned'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status.' });
    }

    // users table has no status column — use banned/suspended booleans
    const update = {
      banned: status === 'banned',
      suspended: status === 'suspended',
    };

    const { error } = await supabase.from('users').update(update).eq('id', id);
    if (error) {
      // If banned/suspended columns don't exist yet, log and continue
      if (error.code === '42703') {
        await logAction(req.admin?.id, req.admin?.name, `User ${status}`, 'user', id, { reason, status });
        return res.json({ message: `User ${status} logged (columns not in schema yet).` });
      }
      return res.status(500).json({ message: error.message });
    }

    // Also update Firebase RTDB so both sources stay in sync
    try {
      const rtdb = getFirebaseRtdb();
      if (rtdb) await rtdb.ref(`users/${id}`).update(update);
    } catch (_) {}

    try {
      const firestoreDb = getFirebaseDb();
      if (firestoreDb) {
        await firestoreDb.collection('users').doc(id).set({
          ...update,
          updatedAt: new Date().toISOString(),
        }, { merge: true });
      }
    } catch (_) {}

    try {
      const auth = getFirebaseAuth();
      if (auth) await auth.updateUser(id, { disabled: status === 'suspended' || status === 'banned' });
    } catch (_) {}

    await logAction(req.admin?.id, req.admin?.name, `User ${status}`, 'user', id, { reason, status });
    return res.json({ message: `User ${status} successfully.` });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── PUT /api/admin/users/:id/coins ────────────────────────────────────────────

export async function updateUserCoins(req, res) {
  try {
    const { id } = req.params;
    const { coin_balance } = req.body;
    if (coin_balance === undefined) return res.status(400).json({ message: 'coin_balance required.' });

    const amount = Number(coin_balance);
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ message: 'coin_balance must be a non-negative number.' });
    }

    let updated = false;

    try {
      await setCoinBalance({
        userId: id,
        targetBalance: amount,
        actorId: req.admin?.id,
        reason: 'Admin reset coin balance',
      });
      updated = true;
    } catch (walletError) {
      console.warn('[adminUsers] coin wallet adjustment failed, falling back to legacy mirror:', walletError?.message || walletError);
      const { error: sbError } = await supabase
        .from('users')
        .update({ coin_balance: amount })
        .eq('id', id);
      if (!sbError) updated = true;
    }

    // Always sync legacy Firebase mirrors for older frontend sessions.
    try {
      const firestoreDb = getFirebaseDb();
      if (firestoreDb) {
        const userRef = firestoreDb.collection('users').doc(id);
        const snap = await userRef.get();
        if (snap.exists) {
          await userRef.update({ tokenBalance: amount, coinBalance: amount });
          updated = true;
        } else {
          // Create the balance fields if the doc exists under a different structure
          await userRef.set({ tokenBalance: amount, coinBalance: amount }, { merge: true });
          updated = true;
        }
      }
    } catch (_) {}

    // 3. Also sync to RTDB
    try {
      const rtdb = getFirebaseRtdb();
      if (rtdb) {
        await rtdb.ref(`users/${id}`).update({ coinBalance: amount, tokenBalance: amount });
        updated = true;
      }
    } catch (_) {}

    if (!updated) {
      return res.status(404).json({ message: 'User not found in any data source.' });
    }

    await logAction(req.admin?.id, req.admin?.name, 'Reset coin balance', 'user', id, { coin_balance: amount });
    return res.json({ message: 'Coin balance updated.', tokenBalance: amount });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/creators ───────────────────────────────────────────────────

// DELETE /api/admin/users/:id
export async function deleteUser(req, res) {
  try {
    const { id } = req.params;
    const reason = sanitizeAdminReason(req.body?.reason);

    if (!adminCanDeleteUsers(req.admin)) {
      return res.status(403).json({ message: 'You do not have permission to delete users.' });
    }
    if (!id || !String(id).trim()) {
      return res.status(400).json({ message: 'User ID is required.' });
    }
    if (!reason) {
      return res.status(400).json({ message: 'Admin reason is required before deleting a user.' });
    }
    if (String(req.admin?.id || '') === String(id)) {
      return res.status(400).json({ message: 'You cannot delete your own admin account from the user directory.' });
    }

    const { row: mergedRow } = await fetchUserRowForAdminById(id);
    if (!mergedRow) {
      return res.status(404).json({ message: 'User not found in any connected source.' });
    }

    const user = rowToAdminUserDto(mergedRow);
    const deletionIds = uniqueValues([
      id,
      mergedRow.id,
      mergedRow.firebase_uid,
      mergedRow.firestore_uid,
      mergedRow.rtdb_uid,
      mergedRow.supabase_user_id,
    ]);
    const email = user.email || mergedRow.email || '';
    const displayName = user.display_name || user.username || email || 'there';

    try {
      await logAction(req.admin?.id, req.admin?.name, 'User deletion requested', 'user', id, {
        reason,
        email,
        displayName,
        deletionIds,
      });
    } catch (err) {
      console.error('[deleteUser] audit preflight failed:', err?.message || err);
      return res.status(500).json({
        message: 'User deletion could not start because the audit log could not be written.',
      });
    }

    let supabaseCleanup = [];
    try {
      supabaseCleanup = await cleanupSupabaseUserData(deletionIds);
    } catch (cleanupErr) {
      console.error('[deleteUser] Supabase cleanup failed:', cleanupErr?.message || cleanupErr);
      return res.status(500).json({
        message: 'User deletion failed while cleaning database records.',
        error: cleanupErr?.message || String(cleanupErr),
      });
    }

    const firebaseCleanup = await cleanupFirebaseUserData(deletionIds);

    let emailSent = false;
    let emailError = null;
    if (email) {
      try {
        await sendAccountDeletionEmail({
          to: email,
          name: displayName,
          reason,
          platformUrl: process.env.FRONTEND_URL || 'https://xstreamvideos.site',
        });
        emailSent = true;
      } catch (err) {
        emailError = err?.message || String(err);
        console.error('[deleteUser] deletion email failed:', emailError);
      }
    }

    let auditLogged = false;
    try {
      await logAction(req.admin?.id, req.admin?.name, 'User deleted', 'user', id, {
        reason,
        email,
        displayName,
        deletionIds,
        emailSent,
        emailError,
        supabaseCleanup,
        firebaseCleanup,
      });
      auditLogged = true;
    } catch (err) {
      console.error('[deleteUser] audit log failed:', err?.message || err);
    }

    return res.json({
      message: emailSent
        ? 'User deleted successfully and deletion email sent.'
        : 'User deleted successfully. Deletion email could not be sent.',
      deleted: true,
      emailSent,
      emailError,
      auditLogged,
      cleanup: {
        supabase: supabaseCleanup,
        firebase: firebaseCleanup,
      },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

export async function getPlatformCreators(req, res) {
  try {
    const result = await listPlatformCreatorsFromDirectory(req.query);
    if (result.error) {
      return res.status(500).json({ message: result.error });
    }
    return res.json({
      creators: result.creators,
      total: result.total,
      page: result.page,
      limit: result.limit,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── PUT /api/admin/creators/:id/status ───────────────────────────────────────

export async function updateCreatorStatus(req, res) {
  try {
    const { id } = req.params;
    const { status, reason = '' } = req.body;
    if (!['active', 'suspended', 'banned'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status.' });
    }

    // Resolve creator → user_id, then update the users table
    const creatorQuery = isUuidLike(id)
      ? supabase.from('creators').select('id,user_id').eq('id', id).maybeSingle()
      : supabase.from('creators').select('id,user_id').eq('user_id', id).maybeSingle();
    const { data: creator, error: fetchErr } = await creatorQuery;
    if (fetchErr) return res.status(500).json({ message: fetchErr.message });

    const userId = creator?.user_id || id;
    if (userId) {
      await supabase.from('users').update({
        banned: status === 'banned',
        suspended: status === 'suspended',
      }).eq('id', userId);

      const creatorUpdate = await supabase.from('creators').update({
        status,
        active: status === 'active',
        updated_at: new Date().toISOString(),
      }).eq('user_id', userId);
      if (creatorUpdate.error && !isColumnMissingError(creatorUpdate.error) && !isMissingTable(creatorUpdate.error)) {
        return res.status(500).json({ message: creatorUpdate.error.message });
      }

      const firestoreDb = getFirebaseDb();
      if (firestoreDb) {
        await firestoreDb.collection('users').doc(userId).set({
          banned: status === 'banned',
          suspended: status === 'suspended',
          creatorProfileStatus: status,
          updatedAt: new Date().toISOString(),
        }, { merge: true }).catch(() => {});
      }
      const rtdb = getFirebaseRtdb();
      if (rtdb) {
        await rtdb.ref(`users/${userId}`).update({
          banned: status === 'banned',
          suspended: status === 'suspended',
          creatorProfileStatus: status,
        }).catch(() => {});
      }
    }

    await logAction(req.admin?.id, req.admin?.name, `Creator ${status}`, 'creator', id, { reason, userId });
    return res.json({ message: `Creator ${status} successfully.` });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/applications ───────────────────────────────────────────────

export async function getCreatorApplications(req, res) {
  try {
    const { search = '', statusFilter = '' } = req.query;
    const { page, limit, offset } = paginateAdmin(req.query.page, req.query.limit);

    // creator_applications table: id, user_id, data (encrypted jsonb), status, created_at
    // If search is provided, first resolve matching user_ids from users table
    let searchUserIds = null;
    if (search) {
      const { data: matchedUsers } = await supabase
        .from('users').select('id').ilike('username', `%${search}%`);
      searchUserIds = (matchedUsers || []).map(u => u.id);
      if (searchUserIds.length === 0) return res.json({ applications: [], total: 0, page, limit });
    }

    let countQ = supabase.from('creator_applications').select('*', { count: 'exact', head: true });
    if (statusFilter) countQ = countQ.eq('status', statusFilter);
    if (searchUserIds) countQ = countQ.in('user_id', searchUserIds);

    const { count, error: countErr } = await countQ;
    if (countErr) {
      // Supabase unavailable — fall back to Firebase RTDB
      const rtdb = getFirebaseRtdb();
      if (!rtdb) return res.status(500).json({ message: countErr.message });
      try {
        const snap = await rtdb.ref('creator_applications').once('value');
        const val = snap.val();
        if (!val) return res.json({ applications: [], total: 0, page, limit });
        let allApps = Object.entries(val).map(([id, a]) => {
          const app = (typeof a === 'object' && a) ? a : {};
          return {
            id: app.id || id,
            user_id: app.user_id || '',
            name: app.user_id || id,
            username: app.user_id || id,
            email: '',
            avatar_url: null,
            status: app.status || 'pending',
            creator_type: '',
            application_message: '',
            is_verified: false,
            created_at: app.created_at || new Date().toISOString(),
            submitted_at: app.created_at || new Date().toISOString(),
          };
        });
        if (statusFilter) allApps = allApps.filter(a => a.status === statusFilter);
        const total = allApps.length;
        const paginated = allApps.slice(offset, offset + limit);
        return res.json({ applications: paginated, total, page, limit });
      } catch (rtdbErr) {
        return res.status(500).json({ message: countErr.message });
      }
    }

    const total = count || 0;
    if (total === 0 || offset >= total) return res.json({ applications: [], total, page, limit });

    let q = supabase.from('creator_applications')
      .select('*');
    if (statusFilter) q = q.eq('status', statusFilter);
    if (searchUserIds) q = q.in('user_id', searchUserIds);
    q = q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

    const { data: appRows, error } = await q;
    if (error) return res.status(500).json({ message: error.message });
    if (!appRows?.length) return res.json({ applications: [], total, page, limit });

    // Fetch user details for applicants, creator profiles, and reviewer display names.
    const userIds = [...new Set(appRows.map(a => a.user_id).filter(Boolean))];
    const userMap = await buildAdminUserFacetsByIds(userIds);
    const { data: creatorRows } = userIds.length
      ? await supabase.from('creators').select('*').in('user_id', userIds)
      : { data: [] };
    const creatorByUserId = Object.fromEntries((creatorRows || []).map((c) => [c.user_id, c]));

    const reviewerIds = [...new Set(appRows.map(a => a.reviewed_by).filter(Boolean))];
    let reviewerById = {};
    if (reviewerIds.length) {
      const { data: admins } = await supabase
        .from('admin_users')
        .select('id,name,email')
        .in('id', reviewerIds);
      reviewerById = Object.fromEntries((admins || []).map((admin) => [admin.id, admin.name || admin.email || 'Admin']));
    }

    let applications = appRows.map(a => {
      const u = userMap[a.user_id] || {};
      const creator = creatorByUserId[a.user_id] || {};
      let appData = {};
      try { appData = decryptApplicationData(a.data || {}); } catch (_) {}

      const firstName = appData.firstName || '';
      const lastName = appData.lastName || '';
      const fullName = displayNameFromApplicationData(appData, u.username || a.user_id);

      return {
        id: a.id,
        user_id: a.user_id,
        name: fullName,
        username: u.username || a.user_id,
        email: appData.email || u.email || '',
        avatar_url: u.avatar || null,
        status: a.status,
        creator_type: appData.creator_type || '',
        category: appData.creatorCategory || appData.creatorMode || '',
        content_type: appData.contentType || appData.content_type || appData.mainOrientationCategory || '',
        application_message: appData.message || appData.application_message || appData.applicationMessage || '',
        is_verified: !!u.email_verified,
        created_at: a.created_at,
        submitted_at: a.created_at,
        reviewed_at: a.reviewed_at || null,
        reviewed_by: a.reviewed_by || null,
        reviewed_by_name: reviewerById[a.reviewed_by] || '',
        decision_at: a.decision_at || null,
        review_reason: a.review_reason || null,
        rejection_reason: a.status === 'rejected' || a.status === 'banned' ? a.review_reason || null : null,
        ban_reason: a.ban_reason || null,
        ban_expires_at: a.ban_expires_at || null,
        ban_admin_id: a.ban_admin_id || null,
        creator_id: creator.id || null,
        creator_active: creator.active !== false,
        creator_status: creator.status || (a.status === 'approved' ? 'active' : ''),
      };
    });

    // Enrich missing email/avatar/is_verified from Firebase Auth/Firestore when available.
    const rowsForEnrich = applications.map((a) => ({
      id: a.user_id,
      email: a.email,
      avatar_url: a.avatar_url,
      is_verified: a.is_verified,
    }));
    const enriched = await enrichUsersFromFirebase(rowsForEnrich);
    const enrichedMap = new Map(enriched.map((r) => [r.id, r]));
    applications = applications.map((a) => {
      const e = enrichedMap.get(a.user_id);
      if (!e) return a;
      return {
        ...a,
        email: a.email || e.email,
        avatar_url: a.avatar_url || e.avatar_url,
        is_verified: a.is_verified || e.is_verified,
      };
    });

    return res.json({ applications, total, page, limit });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/applications/:id ──────────────────────────────────────────

export async function getApplicationById(req, res) {
  try {
    const { id } = req.params;

    const { data: app, error } = await supabase
      .from('creator_applications')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      if (isMissingTable(error)) {
        const rtdb = getFirebaseRtdb();
        if (rtdb) {
          const snap = await rtdb.ref(`creator_applications/${id}`).once('value');
          const val = snap.val();
          if (val && typeof val === 'object') {
            let appData = {};
            try { appData = decryptApplicationData(val.data || {}); } catch (_) {}
            return res.json({
              id: val.id || id,
              user_id: val.user_id || '',
              status: val.status || 'pending',
              created_at: val.created_at || null,
              username: val.user_id || '',
              avatar_url: null,
              email: appData.email || '',
              is_verified: false,
              data: appData,
            });
          }
        }
        return res.status(404).json({ message: 'Application not found.' });
      }
      return res.status(500).json({ message: error.message });
    }
    if (!app) return res.status(404).json({ message: 'Application not found.' });

    let appData = {};
    try { appData = decryptApplicationData(app.data || {}); } catch (_) {}

    const facets = await buildAdminUserFacetsByIds([app.user_id]);
    const f = facets[app.user_id] || {};
    const { data: creator } = await supabase
      .from('creators')
      .select('*')
      .eq('user_id', app.user_id)
      .maybeSingle();
    let reviewedByName = '';
    if (app.reviewed_by) {
      const { data: adminRow } = await supabase
        .from('admin_users')
        .select('name,email')
        .eq('id', app.reviewed_by)
        .maybeSingle();
      reviewedByName = adminRow?.name || adminRow?.email || '';
    }

    return res.json({
      id: app.id,
      user_id: app.user_id,
      status: app.status,
      created_at: app.created_at,
      username: f.username || app.user_id,
      avatar_url: f.avatar || null,
      email: appData.email || f.email || '',
      is_verified: !!f.email_verified,
      review_reason: app.review_reason || null,
      reviewed_at: app.reviewed_at || null,
      reviewed_by: app.reviewed_by || null,
      reviewed_by_name: reviewedByName,
      decision_at: app.decision_at || null,
      missing_fields: app.missing_fields || [],
      email_sent: !!app.email_sent,
      ban_reason: app.ban_reason || null,
      ban_expires_at: app.ban_expires_at || null,
      ban_admin_id: app.ban_admin_id || null,
      creator_id: creator?.id || null,
      creator_active: creator ? creator.active !== false : false,
      creator_status: creator?.status || '',
      data: appData,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── PUT /api/admin/applications/:id/status ────────────────────────────────────

export async function updateApplicationStatus(req, res) {
  try {
    const { id } = req.params;
    const { status, reason = '', banExpiresAt = null } = req.body;

    if (!adminCanModerateCreators(req.admin)) {
      return res.status(403).json({ message: 'You do not have permission to moderate creator applications.' });
    }
    if (!['approved', 'rejected', 'pending', 'info_requested', 'banned'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status.' });
    }
    const needsReason = ['rejected', 'info_requested', 'banned'].includes(status);
    const normalizedReason = normalizeModerationReason(
      reason,
      status === 'approved' ? 'Approved by admin' : status === 'pending' ? 'Reopened for review by admin' : '',
    );
    if (needsReason && !normalizedReason) {
      return res.status(400).json({ message: 'Notes or reason is required before submitting a decision.' });
    }

    // Fetch application data early — needed for email + missing field detection
    const app = await fetchApplicationRecord(id);
    if (!app) return res.status(404).json({ message: 'Application not found.' });

    const userId = app.user_id;
    let appData = {};
    try { appData = decryptApplicationData(app.data || {}); } catch (_) {}
    const missingFields = detectMissingFields(appData);
    const { data: user } = await supabase.from('users').select('*').eq('id', userId).maybeSingle();
    const emailAddress = appData.email || user?.email || '';
    const displayName = displayNameFromApplicationData(appData, user?.username || 'Creator');

    // Generate update token for info_requested status
    let updateToken = null;
    let tokenExpiresAt = null;
    if (status === 'info_requested') {
      updateToken = generateUpdateToken();
      tokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    }

    // ── Supabase update ───────────────────────────────────────────────────────
    const now = new Date().toISOString();
    let ban = null;
    if (status === 'banned') {
      ban = {
        banned: true,
        reason: normalizedReason,
        adminId: req.admin?.id || null,
        expiresAt: banExpiresAt || null,
      };
      await setCreatorApplicationBan(userId, ban);
    } else if (status === 'approved' || status === 'pending') {
      ban = await setCreatorApplicationBan(userId, { banned: false });
    }

    const extendedPayload = {
      status,
      review_reason: normalizedReason,
      reviewed_at: now,
      reviewed_by: req.admin?.id || null,
      decision_at: status === 'pending' ? null : now,
      missing_fields: status === 'info_requested' ? missingFields : [],
      update_token: null,
      token_expires_at: null,
    };
    if (status === 'info_requested') {
      extendedPayload.update_token = updateToken;
      extendedPayload.token_expires_at = tokenExpiresAt;
      extendedPayload.missing_fields = missingFields;
    }
    if (status === 'banned') {
      extendedPayload.ban_reason = normalizedReason;
      extendedPayload.ban_expires_at = banExpiresAt || null;
      extendedPayload.ban_admin_id = req.admin?.id || null;
    }
    if (status === 'pending') {
      extendedPayload.reconsidered_at = now;
      extendedPayload.ban_reason = null;
      extendedPayload.ban_expires_at = null;
      extendedPayload.ban_admin_id = null;
    }

    await updateApplicationLifecycle(id, extendedPayload);
    const lifecycle = await syncCreatorLifecycle(userId, {
      status,
      appData,
      applicationId: id,
      ban,
    });

    await logAction(req.admin?.id, req.admin?.name, `Application ${status}`, 'application', id, {
      reason: normalizedReason,
      previousStatus: app.status,
      userId,
      lifecycle,
      ban,
    });

    /*
    {
      // Full update: includes review columns (requires migration 20260502150000)
      const { error: e1 } = await supabase
        .from('creator_applications')
        .update({ status, review_reason: reason, reviewed_at: now, reviewed_by: req.admin?.id })
        .eq('id', id);

      if (!e1) {
        supabaseOk = true;
      } else if (e1.code === '42703') {
        // review_reason / reviewed_at / reviewed_by columns not yet migrated — update status only
        const { error: e2 } = await supabase
          .from('creator_applications')
          .update({ status })
          .eq('id', id);
        if (!e2) {
          supabaseOk = true;
        } else if (!isMissingTable(e2)) {
          return res.status(500).json({ message: e2.message });
        }
      } else if (!isMissingTable(e1)) {
        return res.status(500).json({ message: e1.message });
      }
    }

    // ── Firestore fallback (only when Supabase table is entirely missing) ────
    if (!supabaseOk) {
      try {
        const db = getFirebaseDb();
        if (db) {
          // .set with merge:true = safe upsert — never throws NOT_FOUND
          await db.collection('creatorApplications').doc(id).set(
            { status, reason, reviewedAt: now },
            { merge: true },
          );
        }
      } catch (firestoreErr) {
        console.error('[updateApplicationStatus] Firestore fallback failed:', firestoreErr?.message);
        // Don't crash — proceed so email + logAction still fire
      }
    }

    // Extended update with new tracking columns (soft-fail if migration not yet applied)
    const extendedPayload = { decision_at: now };
    if (status === 'info_requested') {
      extendedPayload.update_token = updateToken;
      extendedPayload.token_expires_at = tokenExpiresAt;
      extendedPayload.missing_fields = missingFields;
    }
    await supabase.from('creator_applications').update(extendedPayload).eq('id', id);

    await logAction(req.admin?.id, req.admin?.name, `Application ${status}`, 'application', id, { reason });

    */

    // Send decision email
    if (emailAddress) {
      try {
        const frontendUrl = process.env.FRONTEND_URL || 'https://xstreamvideos.site';
        const updateLink = updateToken ? `${frontendUrl}/apply/update?token=${updateToken}` : null;
        await sendApplicationDecisionEmail({
          to: emailAddress,
          name: displayName,
          status,
          reason: normalizedReason,
          missingFields: status === 'info_requested' ? missingFields : [],
          updateLink,
        });
        await supabase.from('creator_applications').update({ email_sent: true }).eq('id', id);
      } catch (_) {}
    }

    return res.json({
      message: status === 'approved'
        ? 'Application approved and creator profile activated.'
        : status === 'pending'
          ? 'Application reopened for review.'
          : status === 'banned'
            ? 'Applicant has been banned from applying.'
            : `Application ${status} successfully.`,
      application: { id, status },
      retained: true,
      lifecycle,
    });

    /*
    // Update the user's creator flag + creators table when approved / rejected
    let deleted = false;
    if (userId && (status === 'approved' || status === 'rejected')) {
      try {
        await updateUserCreatorStatus(userId, status === 'approved');
      } catch (e) {
        console.error('[updateApplicationStatus] Failed to update user creator flag:', e?.message);
      }

      // Sync Firestore so the /me endpoint returns updated creatorStatus immediately
      try {
        const db = getFirebaseDb();
        if (db) {
          await db.collection('users').doc(userId).set({
            creatorStatus: status === 'approved' ? 'approved' : 'rejected',
            creator: status === 'approved',
            updatedAt: new Date().toISOString(),
          }, { merge: true });
        }
      } catch (firestoreErr) {
        console.warn('[updateApplicationStatus] Firestore creatorStatus sync failed:', firestoreErr?.message);
      }

      if (status === 'approved') {
        try {
          // Fetch the creator_type from the application data so the creators row reflects it
          const { data: appRow } = await supabase
            .from('creator_applications').select('data').eq('id', id).maybeSingle();
          let creator_type = 'pstar';
          if (appRow) {
            try {
              const d = decryptApplicationData(appRow.data || {});
              if (d.creator_type === 'channel') creator_type = 'channel';
            } catch (_) {}
          }
          await upsertCreator(userId, { verified: true, creator_type });
        } catch (e) {
          console.error('[updateApplicationStatus] Failed to update creators table:', e?.message);
        }
      }

      // Keep the reviewed application row for admin audit/history and future payload review.
      // The partial unique index only blocks pending/info_requested rows, so approved users can reapply later if needed.
      deleted = false;
    }

    return res.json({ message: `Application ${status} successfully.`, deleted, retained: true });
    */
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/application-update/:token (public — no admin auth) ─────────

export async function removeCreatorAccess(req, res) {
  try {
    const { id } = req.params;
    const reason = normalizeModerationReason(req.body?.reason);

    if (!adminCanModerateCreators(req.admin)) {
      return res.status(403).json({ message: 'You do not have permission to moderate creator applications.' });
    }
    if (!reason) {
      return res.status(400).json({ message: 'A reason is required to remove creator access.' });
    }

    const app = await fetchApplicationRecord(id);
    if (!app) return res.status(404).json({ message: 'Application not found.' });

    let appData = {};
    try { appData = decryptApplicationData(app.data || {}); } catch (_) {}
    const now = new Date().toISOString();
    await updateApplicationLifecycle(id, {
      status: 'rejected',
      review_reason: `Creator access removed: ${reason}`,
      reviewed_at: now,
      reviewed_by: req.admin?.id || null,
      decision_at: now,
    });
    const lifecycle = await syncCreatorLifecycle(app.user_id, {
      status: 'rejected',
      appData,
      applicationId: id,
      ban: null,
    });

    await logAction(req.admin?.id, req.admin?.name, 'Creator access removed', 'application', id, {
      reason,
      userId: app.user_id,
      previousStatus: app.status,
      lifecycle,
    });

    return res.json({ message: 'Creator access removed and application moved to rejected.', application: { id, status: 'rejected' }, lifecycle });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

export async function deleteCreatorApplication(req, res) {
  try {
    const { id } = req.params;
    const reason = normalizeModerationReason(req.body?.reason);

    if (!adminCanModerateCreators(req.admin)) {
      return res.status(403).json({ message: 'You do not have permission to delete creator applications.' });
    }
    if (!reason) {
      return res.status(400).json({ message: 'A reason is required before deleting an application.' });
    }

    const app = await fetchApplicationRecord(id);
    if (!app) return res.status(404).json({ message: 'Application not found.' });
    if (!['rejected', 'banned'].includes(app.status)) {
      return res.status(409).json({ message: 'Only rejected or banned applications can be deleted.' });
    }

    await logAction(req.admin?.id, req.admin?.name, 'Application deleted', 'application', id, {
      reason,
      userId: app.user_id,
      previousStatus: app.status,
    });

    const { error } = await supabase.from('creator_applications').delete().eq('id', id);
    if (error) return res.status(500).json({ message: error.message });

    const rtdb = getFirebaseRtdb();
    if (rtdb) {
      await rtdb.ref(`creator_applications/${id}`).remove().catch(() => {});
      await rtdb.ref(`creatorApplications/${id}`).remove().catch(() => {});
    }

    return res.json({ message: 'Application deleted successfully.', deleted: true });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

export async function getApplicationByToken(req, res) {
  try {
    const { token } = req.params;
    if (!token) return res.status(400).json({ message: 'Token required.' });

    const { data: app, error } = await supabase
      .from('creator_applications')
      .select('id, status, missing_fields, token_expires_at, data')
      .eq('update_token', token)
      .maybeSingle();

    if (error) return res.status(500).json({ message: error.message });
    if (!app) return res.status(404).json({ message: 'This link is invalid or has already been used.' });

    if (app.token_expires_at && new Date(app.token_expires_at) < new Date()) {
      return res.status(410).json({ message: 'This update link has expired. Please contact support for a new one.' });
    }

    let appData = {};
    try { appData = decryptApplicationData(app.data || {}); } catch (_) {}

    return res.json({
      id: app.id,
      status: app.status,
      missingFields: app.missing_fields || [],
      expiresAt: app.token_expires_at,
      currentValues: {
        phone: appData.phone || '',
        bio: appData.bio || '',
        idType: appData.idType || '',
        idNumber: appData.idNumber || '',
        instagramUrl: appData.instagramUrl || '',
        xUrl: appData.xUrl || '',
        tiktokUrl: appData.tiktokUrl || '',
        youtubeUrl: appData.youtubeUrl || '',
        websiteUrl: appData.websiteUrl || '',
      },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── POST /api/admin/application-update/:token (public — no admin auth) ────────

export async function updateApplicationByToken(req, res) {
  try {
    const { token } = req.params;
    if (!token) return res.status(400).json({ message: 'Token required.' });

    const { data: app, error } = await supabase
      .from('creator_applications')
      .select('id, data, token_expires_at')
      .eq('update_token', token)
      .maybeSingle();

    if (error) return res.status(500).json({ message: error.message });
    if (!app) return res.status(404).json({ message: 'This link is invalid or has already been used.' });

    if (app.token_expires_at && new Date(app.token_expires_at) < new Date()) {
      return res.status(410).json({ message: 'This update link has expired.' });
    }

    let existingData = {};
    try { existingData = decryptApplicationData(app.data || {}); } catch (_) {}

    const allowed = ['phone', 'bio', 'idType', 'idNumber', 'instagramUrl', 'xUrl', 'tiktokUrl', 'youtubeUrl', 'websiteUrl'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined && req.body[key] !== null) {
        updates[key] = String(req.body[key]).trim();
      }
    }

    const mergedData = { ...existingData, ...updates };
    const encryptedData = encryptApplicationData(mergedData);

    const { error: updateError } = await supabase
      .from('creator_applications')
      .update({
        data: encryptedData,
        status: 'pending',
        update_token: null,
        token_expires_at: null,
      })
      .eq('id', app.id);

    if (updateError) return res.status(500).json({ message: updateError.message });

    return res.json({ message: 'Your application has been updated and resubmitted for review. We will get back to you shortly.' });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── PUT /api/admin/users/:id/creator-type ─────────────────────────────────────

export async function updateCreatorType(req, res) {
  try {
    const { id } = req.params; // user_id
    const { creator_type } = req.body;
    if (!['pstar', 'channel'].includes(creator_type)) {
      return res.status(400).json({ message: "creator_type must be 'pstar' or 'channel'." });
    }
    try {
      await upsertCreator(id, { creator_type });
    } catch (e) {
      return res.status(500).json({ message: e.message });
    }
    await logAction(req.admin?.id, req.admin?.name, 'Creator type changed', 'creator', id, { creator_type });
    return res.json({ message: `Creator type updated to ${creator_type}.` });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}
