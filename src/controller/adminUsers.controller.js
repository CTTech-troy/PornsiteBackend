import { randomUUID, randomBytes } from 'crypto';
import { supabase } from '../config/supabase.js';
import { getFirebaseDb, getFirebaseRtdb } from '../config/firebase.js';
import { decryptApplicationData, encryptApplicationData } from '../config/encrypt.js';
import { sendApplicationDecisionEmail } from '../services/emailService.js';

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

function normalizeSupabaseUser(u) {
  return {
    id: u.id,
    username: u.username || u.displayName || u.id,
    email: u.email || '',
    display_name: u.username || u.displayName || u.id,
    avatar_url: u.avatar || u.avatar_url || u.photoURL || null,
    coin_balance: Number(u.coin_balance || u.coinBalance) || 0,
    active_plan: u.active_plan || null,
    plan_expires_at: u.plan_expires_at || null,
    is_creator: !!(u.creator || u.is_creator),
    creator_status: u.verified || u.creator_status || 'none',
    status: u.banned ? 'banned' : u.suspended ? 'suspended' : 'active',
    is_verified: !!(u.email_verified || u.emailVerified),
    followers: Number(u.followers) || 0,
    following: Number(u.following) || 0,
    created_at: u.created_at || new Date().toISOString(),
  };
}

function normalizeRtdbUser(id, u) {
  return {
    id,
    username: u.username || u.displayName || id,
    email: u.email || '',
    display_name: u.username || u.displayName || id,
    avatar_url: u.avatar || u.photoURL || null,
    coin_balance: Number(u.coin_balance || u.coinBalance) || 0,
    active_plan: null,
    plan_expires_at: null,
    is_creator: !!u.creator,
    creator_status: u.creatorStatus || u.verified || 'none',
    status: 'active',
    is_verified: !!u.emailVerified || !!u.email_verified,
    followers: Number(u.followers) || 0,
    following: Number(u.following) || 0,
    created_at: u.created_at || u.createdAt || new Date().toISOString(),
  };
}

function paginate(page, limit) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  return { page: p, limit: l, offset: (p - 1) * l };
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
    const { search = '', statusFilter = '', planFilter = '', verifiedFilter = '' } = req.query;
    const { page, limit, offset } = paginate(req.query.page, req.query.limit);

    // users table columns (email lives in auth.users, not the public users table)
    let countQ = supabase.from('users').select('*', { count: 'exact', head: true });
    if (statusFilter === 'creator') countQ = countQ.eq('creator', true);
    if (verifiedFilter === 'true') countQ = countQ.eq('email_verified', true);
    if (search) countQ = countQ.ilike('username', `%${search}%`);

    const { count, error: countErr } = await countQ;

    // Use Supabase results whenever there is no error (count=0 is a valid empty result)
    if (!countErr) {
      const total = count || 0;
      if (total === 0 || offset >= total) return res.json({ users: [], total, page, limit });

      let q = supabase.from('users').select('*');
      if (statusFilter === 'creator') q = q.eq('creator', true);
      if (verifiedFilter === 'true') q = q.eq('email_verified', true);
      if (search) q = q.ilike('username', `%${search}%`);
      q = q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

      const { data, error } = await q;
      if (error) return res.status(500).json({ message: error.message });

      return res.json({ users: (data || []).map(normalizeSupabaseUser), total, page, limit });
    }

    // Fallback: read from Firebase RTDB only when Supabase itself errored
    const rtdb = getFirebaseRtdb();
    if (!rtdb) {
      return res.json({ users: [], total: 0, page, limit });
    }

    const snap = await rtdb.ref('users').once('value');
    const val = snap.val();
    if (!val || typeof val !== 'object') {
      return res.json({ users: [], total: 0, page, limit });
    }

    let allUsers = Object.entries(val).map(([id, u]) =>
      normalizeRtdbUser(id, typeof u === 'object' && u !== null ? u : {})
    );

    if (search) {
      const s = search.toLowerCase();
      allUsers = allUsers.filter(u =>
        u.username.toLowerCase().includes(s) || u.email.toLowerCase().includes(s)
      );
    }
    if (statusFilter === 'creator') allUsers = allUsers.filter(u => u.is_creator);
    if (statusFilter === 'banned') allUsers = allUsers.filter(u => u.status === 'banned');
    if (statusFilter === 'suspended') allUsers = allUsers.filter(u => u.status === 'suspended');
    if (statusFilter === 'active') allUsers = allUsers.filter(u => u.status === 'active');

    allUsers.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const total = allUsers.length;
    const paginated = allUsers.slice(offset, offset + limit);
    return res.json({ users: paginated, total, page, limit });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/users/:id ──────────────────────────────────────────────────

export async function getUserById(req, res) {
  try {
    const { id } = req.params;
    const { data: raw, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    // Fallback to RTDB if not in Supabase
    let user;
    if (error || !raw) {
      const rtdb = getFirebaseRtdb();
      if (rtdb) {
        const snap = await rtdb.ref(`users/${id}`).once('value');
        const val = snap.val();
        if (val) user = normalizeRtdbUser(id, val);
      }
    } else {
      user = normalizeSupabaseUser(raw);
    }

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
    if (user.is_creator) {
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
    const { search = '', verifiedFilter = '', typeFilter = '' } = req.query;
    const { page, limit, offset } = paginate(req.query.page, req.query.limit);

    // Build count query
    let countQ = supabase.from('creators').select('*', { count: 'exact', head: true });
    if (search) countQ = countQ.ilike('display_name', `%${search}%`);
    if (typeFilter === 'pstar' || typeFilter === 'channel') countQ = countQ.eq('creator_type', typeFilter);

    const { count, error: countErr } = await countQ;
    if (countErr) return res.status(500).json({ message: countErr.message });

    const total = count || 0;
    if (total === 0 || offset >= total) return res.json({ creators: [], total, page, limit });

    let q = supabase.from('creators')
      .select('id, user_id, display_name, bio, creator_type, created_at, updated_at');
    if (search) q = q.ilike('display_name', `%${search}%`);
    if (typeFilter === 'pstar' || typeFilter === 'channel') q = q.eq('creator_type', typeFilter);
    q = q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

    const { data: creatorRows, error } = await q;
    if (error) return res.status(500).json({ message: error.message });
    if (!creatorRows?.length) return res.json({ creators: [], total, page, limit });

    // Join users table for avatar, email, followers, verification status
    const userIds = [...new Set(creatorRows.map(c => c.user_id).filter(Boolean))];
    const { data: userRows } = await supabase.from('users').select('*').in('id', userIds);
    const userMap = Object.fromEntries((userRows || []).map(u => [u.id, u]));

    let creators = creatorRows.map(c => {
      const u = userMap[c.user_id] || {};
      const resolvedType = c.creator_type === 'channel' ? 'channel' : 'pstar';
      return {
        id:           c.id,
        user_id:      c.user_id,
        username:     u.username || c.user_id,
        display_name: c.display_name || u.username || c.user_id,
        creator_type: resolvedType,
        email:        u.email || '',
        avatar_url:   u.avatar || u.avatar_url || null,
        status:       u.banned ? 'banned' : u.suspended ? 'suspended' : 'active',
        is_verified:  !!(u.verified && u.verified !== 'none' && u.verified !== 'rejected' && u.verified !== 'pending'),
        followers:    Number(u.followers) || 0,
        created_at:   c.created_at,
      };
    });

    if (verifiedFilter === 'true') creators = creators.filter(c => c.is_verified);

    return res.json({ creators, total, page, limit });
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
    const { page, limit, offset } = paginate(req.query.page, req.query.limit);

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
    if (countErr) return res.status(500).json({ message: countErr.message });

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
    const { data: userRows } = await supabase.from('users').select('*').in('id', userIds);
    const userMap = Object.fromEntries((userRows || []).map(u => [u.id, u]));

    const applications = appRows.map(a => {
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
        avatar_url: u.avatar || u.avatar_url || null,
        status: a.status,
        creator_type: appData.creator_type || '',
        created_at: a.created_at,
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

    const { data: user } = await supabase.from('users').select('*').eq('id', app.user_id).maybeSingle();

    return res.json({
      id: app.id,
      user_id: app.user_id,
      status: app.status,
      created_at: app.created_at,
      username: user?.username || app.user_id,
      avatar_url: user?.avatar || user?.avatar_url || null,
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

    try {
      const { data: app } = await supabase
        .from('creator_applications')
        .select('user_id, data')
        .eq('id', id)
        .maybeSingle();
      if (app) {
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

    return res.json({ message: `Application ${status} successfully.` });
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
