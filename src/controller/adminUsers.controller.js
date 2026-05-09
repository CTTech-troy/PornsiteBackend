import { randomUUID, randomBytes } from 'crypto';
import { supabase } from '../config/supabase.js';
import { getFirebaseDb, getFirebaseRtdb } from '../config/firebase.js';
import { decryptApplicationData, encryptApplicationData } from '../config/encrypt.js';
import { sendApplicationDecisionEmail } from '../services/emailService.js';
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
  await supabase.from('admin_audit_logs').insert({
    id: randomUUID(),
    admin_id: adminId || null,
    admin_name: adminName || 'Admin',
    action,
    target_type: targetType,
    target_id: String(targetId || ''),
    details,
    status: 'success',
  });
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
      total: result.total,
      page: result.page,
      limit: result.limit,
      supabaseTotal: result.supabaseTotal,
      firebaseOnlyTotal: result.firebaseOnlyTotal,
      firebaseOnlyUsers: result.firebaseOnlyUsers,
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

    // 1. Try Supabase (users stored there use coin_balance)
    const { error: sbError } = await supabase
      .from('users')
      .update({ coin_balance: amount })
      .eq('id', id);
    if (!sbError) updated = true;

    // 2. Always sync to Firestore (Firebase-auth users store tokenBalance there)
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
    const { data: creator, error: fetchErr } = await supabase
      .from('creators').select('user_id').eq('id', id).maybeSingle();
    if (fetchErr) return res.status(500).json({ message: fetchErr.message });

    const userId = creator?.user_id;
    if (userId) {
      await supabase.from('users').update({
        banned: status === 'banned',
        suspended: status === 'suspended',
      }).eq('id', userId);
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
      .select('id, user_id, data, status, created_at');
    if (statusFilter) q = q.eq('status', statusFilter);
    if (searchUserIds) q = q.in('user_id', searchUserIds);
    q = q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

    const { data: appRows, error } = await q;
    if (error) return res.status(500).json({ message: error.message });
    if (!appRows?.length) return res.json({ applications: [], total, page, limit });

    // Fetch user details for applicants
    const userIds = [...new Set(appRows.map(a => a.user_id).filter(Boolean))];
    const userMap = await buildAdminUserFacetsByIds(userIds);

    let applications = appRows.map(a => {
      const u = userMap[a.user_id] || {};
      let appData = {};
      try { appData = decryptApplicationData(a.data || {}); } catch (_) {}

      const firstName = appData.firstName || '';
      const lastName = appData.lastName || '';
      const fullName = [firstName, lastName].filter(Boolean).join(' ') || u.username || a.user_id;

      return {
        id: a.id,
        user_id: a.user_id,
        name: fullName,
        username: u.username || a.user_id,
        email: appData.email || u.email || '',
        avatar_url: u.avatar || null,
        status: a.status,
        creator_type: appData.creator_type || '',
        application_message: appData.message || appData.application_message || appData.applicationMessage || '',
        is_verified: !!u.email_verified,
        created_at: a.created_at,
        submitted_at: a.created_at,
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
      .select('id, user_id, data, status, created_at')
      .eq('id', id)
      .maybeSingle();

    if (error) return res.status(500).json({ message: error.message });
    if (!app) return res.status(404).json({ message: 'Application not found.' });

    let appData = {};
    try { appData = decryptApplicationData(app.data || {}); } catch (_) {}

    const facets = await buildAdminUserFacetsByIds([app.user_id]);
    const f = facets[app.user_id] || {};

    return res.json({
      id: app.id,
      user_id: app.user_id,
      status: app.status,
      created_at: app.created_at,
      username: f.username || app.user_id,
      avatar_url: f.avatar || null,
      email: f.email || '',
      is_verified: !!f.email_verified,
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
    const { status, reason = '' } = req.body;

    if (!['approved', 'rejected', 'pending', 'info_requested'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status.' });
    }
    if (!reason.trim()) {
      return res.status(400).json({ message: 'Notes or reason is required before submitting a decision.' });
    }

    // Fetch application data early — needed for email + missing field detection
    let emailAddress = '';
    let displayName = 'Creator';
    let missingFields = [];
    let userId = null;

    try {
      const { data: app } = await supabase
        .from('creator_applications')
        .select('user_id, data')
        .eq('id', id)
        .maybeSingle();
      if (app) {
        userId = app.user_id;
        let appData = {};
        try { appData = decryptApplicationData(app.data || {}); } catch (_) {}
        missingFields = detectMissingFields(appData);
        const { data: user } = await supabase.from('users').select('*').eq('id', app.user_id).maybeSingle();
        emailAddress = appData.email || user?.email || '';
        displayName = [appData.firstName, appData.lastName].filter(Boolean).join(' ') || user?.username || 'Creator';
      }
    } catch (_) {}

    // Generate update token for info_requested status
    let updateToken = null;
    let tokenExpiresAt = null;
    if (status === 'info_requested') {
      updateToken = generateUpdateToken();
      tokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    }

    // ── Supabase update ───────────────────────────────────────────────────────
    const now = new Date().toISOString();
    let supabaseOk = false;

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

    // Send decision email
    if (emailAddress) {
      try {
        const frontendUrl = process.env.FRONTEND_URL || 'https://xstreamvideos.site';
        const updateLink = updateToken ? `${frontendUrl}/apply/update?token=${updateToken}` : null;
        await sendApplicationDecisionEmail({
          to: emailAddress,
          name: displayName,
          status,
          reason,
          missingFields: status === 'info_requested' ? missingFields : [],
          updateLink,
        });
        await supabase.from('creator_applications').update({ email_sent: true }).eq('id', id);
      } catch (_) {}
    }

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

      // Delete the application request to free DB space (required behavior).
      try {
        const { error: delErr } = await supabase.from('creator_applications').delete().eq('id', id);
        if (!delErr) deleted = true;
      } catch (_) {}

      // Best-effort cleanup in Firestore fallback store (if used anywhere).
      try {
        const db = getFirebaseDb();
        if (db) await db.collection('creatorApplications').doc(id).delete();
      } catch (_) {}

      // Best-effort cleanup in RTDB fallback.
      try {
        const rtdb = getFirebaseRtdb();
        if (rtdb) await rtdb.ref(`creator_applications/${id}`).remove();
      } catch (_) {}
    }

    return res.json({ message: `Application ${status} successfully.`, deleted });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/application-update/:token (public — no admin auth) ─────────

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
