import { getFirebaseAuth, getFirebaseDb, getFirebaseRtdb } from '../config/firebase.js';
import { supabase, isConfigured } from '../config/supabase.js';
import { sendVerificationEmail, sendApplicationDecisionEmail, sendPasswordResetEmail } from '../services/emailService.js';
import { insertUser, insertCreatorApplication, getUserCreatorStatus, updateUserCreatorStatus, updateUserWithCreatorApplication, insertMedia } from '../config/dbFallback.js';
import { encryptApplicationData } from '../config/encrypt.js';
import { v4 as uuidv4 } from 'uuid';
import { upsertCreator } from './creator.controller.js';
import fetch from 'node-fetch';
import crypto from 'crypto';
import { mintSessionToken, resolveUidFromBearerToken } from '../utils/sessionToken.js';
import { createLoginTimer, createSignupTimer } from '../utils/authLoginTiming.js';
import { recordAuth } from '../utils/authMetrics.js';
import {
  signInWithPassword as firebaseRestSignIn,
  confirmPasswordResetWithOobCode,
} from '../services/firebaseAuthRestService.js';
import { ensureVideoFilenameForStorage, resolveVideoContentType } from '../utils/videoStorage.js';
import {
  createVerificationToken,
  consumeVerificationToken,
  invalidateUnusedTokensForUser,
  isEmailVerifiedFlag,
  isLoginEmailVerifiedOk,
  issueFreshVerificationEmail,
} from '../services/emailVerificationService.js';
import {
  publicFrontendUrl,
  buildAppVerificationUrl,
  isLocalDevUrlsConfigured,
} from '../utils/authPublicUrls.js';

/** Fetch balance + social counts + email_verified from Supabase for a given uid. Never throws. */
async function _getSupabaseProfile(uid) {
  if (!uid || !isConfigured() || !supabase) return {};
  try {
    const { data, error } = await supabase
      .from('users')
      .select('avatar, followers, following, coin_balance, email_verified, email, username, role')
      .eq('id', uid)
      .maybeSingle();
    if (error || !data) return {};
    const evParsed = isEmailVerifiedFlag(data.email_verified);
    return {
      avatar:        data.avatar        ?? null,
      followers:     Number(data.followers    ?? 0),
      following:     Number(data.following    ?? 0),
      tokenBalance:  Number(data.coin_balance ?? 0),
      coinBalance:   Number(data.coin_balance ?? 0),
      emailVerified: evParsed === true ? true : evParsed === false ? false : null,
    };
  } catch {
    return {};
  }
}

export async function signup(req, res) {
  const mark = createSignupTimer();
  try {
    const { name, email, password, acceptTerms } = req.body;

    if (!name || !name.trim()) {
      recordAuth('signupFail');
      return res.status(400).json({ success: false, message: 'Name is required.' });
    }
    if (!email || !email.trim()) {
      recordAuth('signupFail');
      return res.status(400).json({ success: false, message: 'Email is required.' });
    }
    if (!password || password.length < 8) {
      recordAuth('signupFail');
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
    }
    if (acceptTerms !== true && acceptTerms !== 'true') {
      recordAuth('signupFail');
      return res.status(400).json({ success: false, message: 'You must accept the Terms and Conditions.' });
    }

    const auth = getFirebaseAuth();
    const db = getFirebaseDb();
    if (!auth || !db) {
      recordAuth('signupFail');
      return res.status(503).json({ success: false, message: 'Account service is temporarily unavailable.' });
    }

    const userRecord = await auth.createUser({
      email: email.trim().toLowerCase(),
      password,
      displayName: name.trim(),
    });
    mark('createUser(Firebase)');

    const uid = userRecord.uid;
    const emailNorm = email.trim().toLowerCase();
    const avatarUrl = userRecord.photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(emailNorm)}`;

    const nowIso = new Date().toISOString();
    const display = name.trim();
    const userPayload = {
      id: uid,
      username: display.replace(/\s+/g, '_').toLowerCase(),
      display_name: display,
      full_name: display,
      email: emailNorm,
      email_verified: false,
      creator: false,
      role: 'user',
      created_at: nowIso,
      updated_at: nowIso,
      avatar: avatarUrl,
      avatar_url: avatarUrl,
    };

    try {
      await db.collection('users').doc(uid).set(
        {
          uid,
          name: name.trim(),
          email: emailNorm,
          displayName: name.trim(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          creatorStatus: 'none',
          emailVerified: false,
          avatar: avatarUrl,
          followers: 0,
          following: 0,
        },
        { merge: true }
      );
    } catch (dbErr) {
      console.error('Firestore user stub on signup:', dbErr?.message || dbErr);
    }

    const tokenResult = await createVerificationToken(uid, emailNorm);
    if (!tokenResult.ok) {
      try {
        await auth.deleteUser(uid);
      } catch (_) {}
      recordAuth('signupFail');
      return res.status(503).json({
        success: false,
        message: 'Could not create email verification. Please try again or contact support.',
        code: tokenResult.code || 'VERIFICATION_TOKEN',
      });
    }
    const rawToken = tokenResult.rawToken;

    try {
      await insertUser(userPayload);
    } catch (insErr) {
      console.error('insertUser on signup:', insErr?.message || insErr);
      try {
        await invalidateUnusedTokensForUser(uid);
      } catch (_) {}
      try {
        await auth.deleteUser(uid);
      } catch (_) {}
      recordAuth('signupFail');
      return res.status(503).json({
        success: false,
        message: 'Could not finish registration. Please try again or contact support.',
      });
    }

    const verificationUrl = buildAppVerificationUrl(rawToken);
    let verificationEmailSent = false;
    let localVerificationUrl = null;
    const resendConfigured = !!String(process.env.RESEND_API_KEY || '').trim();

    if (resendConfigured) {
      try {
        await sendVerificationEmail({ to: emailNorm, name: name.trim(), verificationUrl });
        verificationEmailSent = true;
      } catch (emailErr) {
        console.error('Failed to send verification email on signup:', emailErr?.message || emailErr);
        if (isLocalDevUrlsConfigured()) {
          localVerificationUrl = verificationUrl;
        }
      }
    } else {
      console.warn('[email] RESEND_API_KEY is not set — verification email was not sent.');
      if (isLocalDevUrlsConfigured()) {
        localVerificationUrl = verificationUrl;
      }
    }
    mark('verificationEmail');

    recordAuth('signupOk');
    return res.status(201).json({
      success: true,
      uid,
      email: emailNorm,
      displayName: name.trim(),
      emailVerified: false,
      verificationEmailSent,
      emailDeliveryConfigured: resendConfigured,
      ...(localVerificationUrl && { localVerificationUrl }),
    });
  } catch (error) {
    console.error('Signup error:', error);
    recordAuth('signupFail');

    let message = error.message || 'Signup failed.';
    if (error.code === 'auth/email-already-exists') message = 'Email already registered.';
    if (error.code === 'auth/invalid-email') message = 'Invalid email format.';
    if (error.code === 'auth/weak-password') message = 'Password is too weak (min 8 chars).';

    return res.status(400).json({ success: false, message });
  }
}

// Submit age consent (creates app user records after validating ID token)
export async function submitAgeConsent(req, res) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    const idToken = authHeader.slice(7);
    const auth = getFirebaseAuth();
    const db = getFirebaseDb();
    if (!auth || !db) {
      return res.status(503).json({ success: false, message: 'Account service is temporarily unavailable.' });
    }
    let decoded;
    try {
      decoded = await auth.verifyIdToken(idToken);
    } catch (err) {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
    const uid = decoded.uid;

    const { dob, consent } = req.body; // dob as ISO date string, consent boolean
    if (!consent) return res.status(400).json({ success: false, message: 'Consent required' });
    if (!dob) return res.status(400).json({ success: false, message: 'Date of birth required' });

    const birth = new Date(dob);
    if (isNaN(birth.getTime())) return res.status(400).json({ success: false, message: 'Invalid dob' });

    // Calculate age
    const now = new Date();
    let age = now.getFullYear() - birth.getFullYear();
    const m = now.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;

    if (age < 18) return res.status(403).json({ success: false, message: 'Must be 18 or older' });

    // Fetch user record from Firebase to get email/displayName
    const userRecord = await auth.getUser(uid);
    const email = userRecord.email;
    const displayName = userRecord.displayName || (email ? email.split('@')[0] : '');

    // Create Firestore user metadata
    await db.collection('users').doc(uid).set({
      uid,
      name: displayName,
      email: email,
      displayName: displayName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      creatorStatus: 'none',
      avatar: userRecord.photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${email}`,
      followers: 0,
      following: 0,
      dob: birth.toISOString(),
      ageConsent: true,
    });

    // Persist lightweight user in Supabase or RTDB fallback
    try {
      const nowAge = new Date().toISOString();
      const userPayload = {
        id: uid,
        username: displayName.replace(/\s+/g, '_').toLowerCase(),
        display_name: displayName,
        full_name: displayName,
        email: (userRecord.email || '').trim().toLowerCase(),
        email_verified: !!(userRecord.emailVerified),
        avatar_url: userRecord.photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent((userRecord.email || '').trim().toLowerCase() || uid)}`,
        avatar: userRecord.photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent((userRecord.email || '').trim().toLowerCase() || uid)}`,
        role: 'user',
        creator: false,
        created_at: nowAge,
        updated_at: nowAge,
      };
      const insertResult = await insertUser(userPayload);
      console.log(`insertUser result:`, insertResult && insertResult.source ? insertResult.source : insertResult);
    } catch (err) {
      console.error('Failed to persist lightweight user during age-consent:', err && err.message ? err.message : err);
    }

    const sessionToken = mintSessionToken(uid, userRecord.email || '');
    try {
      const customToken = await auth.createCustomToken(uid);
      console.log(`Created custom token for uid=${uid}`);
      return res.status(200).json({
        success: true,
        message: 'Age consent recorded and account completed',
        uid,
        token: customToken,
        ...(sessionToken && { sessionToken }),
      });
    } catch (tokenErr) {
      console.error('Failed to create custom token during age-consent:', tokenErr && tokenErr.message ? tokenErr.message : tokenErr);
      return res.status(200).json({
        success: true,
        message: 'Age consent recorded and account completed',
        uid,
        ...(sessionToken && { sessionToken }),
      });
    }
  } catch (err) {
    console.error('submitAgeConsent error', err);
    return res.status(500).json({ success: false, message: err.message || 'Failed to submit age consent' });
  }
}

// User applies to become creator
export async function applyCreator(req, res) {
  try {
    const uid = req.uid;
    if (!uid) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    // Support both JSON body and multipart/form-data (fields + files).
    // If client uses multipart, form fields will be strings; `applicationData` may be JSON string.
    let applicationData = req.body && req.body.applicationData ? req.body.applicationData : req.body || {};
    if (typeof applicationData === 'string') {
      try {
        applicationData = JSON.parse(applicationData);
      } catch (e) {
        // keep as raw string under a field
        applicationData = { raw: applicationData };
      }
    }

    // If there are uploaded files (req.files), upload them to Supabase and attach URLs
    const attachments = [];
    try {
      const files = req.files || [];
      const bucket = process.env.SUPABASE_CREATOR_BUCKET || process.env.SUPABASE_IMAGE_BUCKET || 'creator_applications';
      if (isConfigured() && supabase) {
        for (const file of files) {
          try {
            const filename = `${uid}/${Date.now()}_${(file.originalname || 'attachment').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
            const { data, error } = await supabase.storage.from(bucket).upload(filename, file.buffer, { contentType: file.mimetype });
            if (error) {
              console.warn('Supabase upload error for creator attachment:', error.message || error);
              continue;
            }
            const baseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
            const publicUrl = `${baseUrl}/storage/v1/object/public/${bucket}/${encodeURIComponent(data.path)}`;
            attachments.push({ name: file.originalname, path: data.path, url: publicUrl, contentType: file.mimetype });

            try {
              const meta = {
                id: uuidv4(),
                user_id: uid,
                bucket,
                path: data.path,
                url: publicUrl,
                type: 'application_attachment',
                title: file.originalname || 'attachment',
                created_at: new Date().toISOString(),
              };
              await insertMedia(meta);
            } catch (metaErr) {
              console.warn('Failed to persist attachment metadata:', metaErr && metaErr.message ? metaErr.message : metaErr);
            }
          } catch (upErr) {
            console.warn('Failed to upload a creator attachment (skipping):', upErr && upErr.message ? upErr.message : upErr);
          }
        }
      } else if (files.length > 0) {
        console.warn('Creator application file attachments skipped: Supabase storage not configured');
      }
    } catch (fileErr) {
      console.warn('Error processing attached files:', fileErr && fileErr.message ? fileErr.message : fileErr);
    }

    // Attach attachments list to application data
    if (attachments.length) applicationData.attachments = attachments;

    // Encrypt sensitive fields before storing (do not log or expose PII)
    const dataToStore = encryptApplicationData({ ...applicationData });

    // Store application with status 'pending' until admin approves.
    // Dedupe: if an open application already exists for this user, replace it instead of inserting.
    const createdAt = new Date().toISOString();
    let payload = {
      id: uuidv4(),
      user_id: uid,
      data: dataToStore,
      status: 'pending',
      created_at: createdAt,
    };
    try {
      if (isConfigured() && supabase) {
        const { data: existing } = await supabase
          .from('creator_applications')
          .select('id, status')
          .eq('user_id', uid)
          .in('status', ['pending', 'info_requested'])
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (existing?.id) {
          payload = { ...payload, id: existing.id };
          await supabase
            .from('creator_applications')
            .update({ data: dataToStore, status: 'pending', created_at: createdAt })
            .eq('id', existing.id);
        } else {
          await insertCreatorApplication(payload);
        }
      } else {
        await insertCreatorApplication(payload);
      }
    } catch (err) {
      console.error('Failed to persist creator application');
      return res.status(500).json({ success: false, message: 'Failed to save application' });
    }

    // Save creator details on the user record and set verified = pending (Supabase + RTDB)
    try {
      await updateUserWithCreatorApplication(uid, dataToStore);
    } catch (err) {
      console.warn('Update user with creator application:', err?.message || err);
    }

    const db = getFirebaseDb();
    const rtdb = getFirebaseRtdb();
    if (db) {
      await db.collection('users').doc(uid).set({
        creatorStatus: 'pending',
        creatorApplicationId: payload.id,
        creator_application: dataToStore,
        verified: 'pending',
      }, { merge: true });
    }

    if (rtdb) {
      try {
        await rtdb.ref(`creators/${uid}`).set({
          user_id: uid,
          verified: false,
          application_id: payload.id,
          status: 'pending',
          created_at: new Date().toISOString(),
        });
        await rtdb.ref(`users/${uid}/creatorStatus`).set('pending');
      } catch (rtdbErr) {
        console.warn('RTDB creator record:', rtdbErr?.message || rtdbErr);
      }
    }

    // Supabase creators row (no PII in profile)
    try {
      const rawType = String(applicationData?.creator_type || '').trim();
      const creatorType = rawType === 'channel' ? 'channel' : 'pstar';
      const creatorProfile = { verified: false, profile: {}, applied_at: new Date().toISOString(), creator_type: creatorType };
      await upsertCreator(uid, creatorProfile);
    } catch (upErr) {
      console.warn('Supabase upsert creator:', upErr?.message || upErr);
    }

    // Admin webhook: do not send user data (PII)
    try {
      const webhook = process.env.ADMIN_WEBHOOK_URL;
      if (webhook) {
        const payloadForAdmin = {
          event: 'creator_application_submitted',
          application_id: payload.id,
          user_id: uid,
          submitted_at: payload.created_at,
        };
        const payloadStr = JSON.stringify(payloadForAdmin);
        
        const headers = { 'Content-Type': 'application/json' };
        // Generate HMAC signature if admin secret exists (use static crypto import)
        if (process.env.ADMIN_SECRET) {
          const signature = crypto.createHmac('sha256', process.env.ADMIN_SECRET).update(payloadStr).digest('hex');
          headers['X-Signature'] = signature;
        }

        await fetch(webhook, {
          method: 'POST',
          headers: headers,
          body: payloadStr,
          timeout: 5000
        });
      }
    } catch (whErr) {
      console.warn('Admin webhook failed');
    }

    return res.status(200).json({ success: true, message: 'Application submitted' });
  } catch (err) {
    if (err && (err.code === 'LIMIT_FILE_SIZE' || err.type === 'entity.too.large' || err.status === 413)) {
      return res.status(413).json({ success: false, message: 'Payload too large' });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
}

// Admin approves creator (legacy endpoint — kept for direct API use)
export async function approveCreator(req, res) {
  try {
    const { user_id, approve, reason = '' } = req.body;

    // SEC-06: Timing-safe admin secret comparison (header only, no query string)
    const adminSecret = req.headers['x-admin-secret'];
    const expectedSecret = process.env.ADMIN_SECRET;
    if (!expectedSecret || !adminSecret) {
      return res.status(401).json({ success: false, message: 'Not authorized' });
    }
    const a = Buffer.from(String(adminSecret));
    const b = Buffer.from(String(expectedSecret));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ success: false, message: 'Not authorized' });
    }

    if (!user_id) return res.status(400).json({ success: false, message: 'user_id required' });

    const newStatus = approve ? 'approved' : 'rejected';

    // 1. Update user creator flag in Supabase + RTDB (always syncs both now)
    try {
      await updateUserCreatorStatus(user_id, approve);
    } catch (err) {
      console.warn('updateUserCreatorStatus failed:', err?.message || err);
    }

    // 2. Sync Firestore so /me returns updated creatorStatus immediately
    const db = getFirebaseDb();
    if (db) {
      await db.collection('users').doc(user_id).set({
        creatorStatus: newStatus,
        creator: !!approve,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    }

    // 3. Update creator_applications table status + upsert creators table on approval
    let emailAddress = '';
    let displayName = 'Creator';
    try {
      if (isConfigured() && supabase) {
        const { data: app } = await supabase
          .from('creator_applications')
          .select('id, data, user_id')
          .eq('user_id', user_id)
          .in('status', ['pending', 'info_requested'])
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (app) {
          await supabase
            .from('creator_applications')
            .update({ status: newStatus, reviewed_at: new Date().toISOString() })
            .eq('id', app.id);

          try {
            const { decryptApplicationData } = await import('../config/encrypt.js');
            const appData = decryptApplicationData(app.data || {});
            emailAddress = appData.email || '';
            displayName = [appData.firstName, appData.lastName].filter(Boolean).join(' ') || '';
            if (approve) {
              const creatorType = appData.creator_type === 'channel' ? 'channel' : 'pstar';
              await upsertCreator(user_id, { verified: true, creator_type: creatorType });
            }
          } catch (_) {}
        }

        if (!emailAddress) {
          const { data: userRow } = await supabase.from('users').select('email, username').eq('id', user_id).maybeSingle();
          emailAddress = userRow?.email || '';
          displayName = displayName || userRow?.username || 'Creator';
        }
      }
    } catch (dbErr) {
      console.warn('approveCreator: DB application update failed:', dbErr?.message || dbErr);
    }

    // Fallback: resolve email from Firebase Auth
    if (!emailAddress) {
      try {
        const auth = getFirebaseAuth();
        if (auth) {
          const userRecord = await auth.getUser(user_id);
          emailAddress = userRecord.email || '';
          displayName = displayName || userRecord.displayName || 'Creator';
        }
      } catch (_) {}
    }

    // 4. Send decision email
    if (emailAddress) {
      try {
        await sendApplicationDecisionEmail({
          to: emailAddress,
          name: displayName || 'Creator',
          status: newStatus,
          reason: reason || '',
        });
      } catch (emailErr) {
        console.warn('approveCreator: decision email failed:', emailErr?.message || emailErr);
      }
    }

    return res.status(200).json({ success: true, message: 'Creator status updated', emailSent: !!emailAddress });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

// Media upload: accepts file via multer and uploads to Supabase Storage
export async function uploadMedia(req, res) {
  try {
    const file = req.file;
    const uid = req.uid; // from requireAuth middleware — never trust client
    const { type = 'video', title = '' } = req.body;
    if (!file) return res.status(400).json({ success: false, message: 'File required' });
    if (!uid)  return res.status(401).json({ success: false, message: 'Authentication required' });
    if (!isConfigured() || !supabase) {
      return res.status(503).json({ success: false, message: 'Storage not configured' });
    }

    const bucket = type === 'image' ? (process.env.SUPABASE_IMAGE_BUCKET || 'images') : (process.env.SUPABASE_VIDEO_BUCKET || 'videos');
    const safeBase =
      type === 'image'
        ? String(file.originalname || 'image')
            .trim()
            .replace(/\\/g, '/')
            .split('/')
            .pop()
            .replace(/[^a-zA-Z0-9._-]/g, '_') || 'image.jpg'
        : ensureVideoFilenameForStorage(file.originalname, file.mimetype);
    const filename = `${uid}/${Date.now()}_${safeBase}`;
    const contentType =
      type === 'image'
        ? file.mimetype || 'image/jpeg'
        : resolveVideoContentType(file.mimetype, safeBase);

    const { data, error } = await supabase.storage.from(bucket).upload(filename, file.buffer, { contentType });
    if (error) throw error;

    const encodedPath = data.path.split('/').map(encodeURIComponent).join('/');
    const publicUrl = `${(process.env.SUPABASE_URL || '').replace(/\/$/, '')}/storage/v1/object/public/${bucket}/${encodedPath}`;

    // Persist avatar changes across sessions/navigation when uploading a profile image.
    const isAvatarUpload =
      type === 'image' &&
      String(req.body?.usage || req.body?.target || '').trim().toLowerCase() === 'avatar';
    if (isAvatarUpload) {
      const auth = getFirebaseAuth();
      const db = getFirebaseDb();
      const rtdb = getFirebaseRtdb();

      if (auth) {
        try {
          await auth.updateUser(uid, { photoURL: publicUrl });
        } catch (err) {
          console.warn('auth.updateUser(photoURL) failed:', err?.message || err);
        }
      }
      if (db) {
        try {
          await db.collection('users').doc(uid).set({ avatar: publicUrl, photoURL: publicUrl, updatedAt: new Date().toISOString() }, { merge: true });
        } catch (err) {
          console.warn('Firestore avatar update failed:', err?.message || err);
        }
      }
      if (rtdb) {
        try {
          await rtdb.ref(`users/${uid}`).update({ avatar: publicUrl, photoURL: publicUrl, updatedAt: new Date().toISOString() });
        } catch (err) {
          console.warn('RTDB avatar update failed:', err?.message || err);
        }
      }
    }

    // store media metadata in Supabase or RTDB fallback
    try {
      const meta = {
        id: uuidv4(),
        user_id: uid,
        bucket,
        path: data.path,
        url: publicUrl,
        type,
        title,
        created_at: new Date().toISOString(),
      };
      const mediaRes = await insertMedia(meta);
      console.log('insertMedia result:', mediaRes && mediaRes.source ? mediaRes.source : mediaRes);
    } catch (err) {
      console.error('Failed to persist media metadata:', err && err.message ? err.message : err);
    }

    return res.status(201).json({
      success: true,
      url: publicUrl,
      path: data.path,
      ...(isAvatarUpload ? { userData: { avatar: publicUrl } } : {}),
    });
  } catch (err) {
    console.error('uploadMedia error', err);
    return res.status(500).json({ success: false, message: err.message || 'Upload failed' });
  }
}

export async function me(req, res) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    const bearer = authHeader.slice(7);
    const uid = await resolveUidFromBearerToken(bearer);
    if (!uid) {
      return res.status(401).json({ success: false, message: 'Invalid or expired session' });
    }

    const auth = getFirebaseAuth();
    const db = getFirebaseDb();
    if (!auth) {
      return res.status(503).json({ success: false, message: 'Account service is temporarily unavailable.' });
    }

    const [userRecord, creatorPack, userDoc, supaProfile] = await Promise.all([
      auth.getUser(uid),
      getUserCreatorStatus(uid),
      db ? db.collection('users').doc(uid).get().catch(() => null) : null,
      _getSupabaseProfile(uid),
    ]);

    const cleanEmail = (userRecord.email || '').trim().toLowerCase();
    const displayName =
      userRecord.displayName || (cleanEmail ? cleanEmail.split('@')[0] : 'User');

    const profileAvatar =
      supaProfile.avatar ||
      userRecord.photoURL ||
      (userDoc?.exists ? userDoc.data()?.avatar || userDoc.data()?.photoURL : null) ||
      null;

    return res.status(200).json({
      success: true,
      uid,
      email: cleanEmail,
      displayName,
      emailVerified: !!(userRecord.emailVerified || supaProfile.emailVerified === true),
      userData: {
        email:         cleanEmail,
        name:          displayName,
        avatar:        profileAvatar,
        creator:       !!creatorPack.creator,
        creatorStatus: creatorPack.creatorStatus || 'none',
        followers:     supaProfile.followers    ?? 0,
        following:     supaProfile.following    ?? 0,
        tokenBalance:  supaProfile.tokenBalance ?? 0,
        coinBalance:   supaProfile.coinBalance  ?? 0,
        emailVerified: !!(userRecord.emailVerified || supaProfile.emailVerified === true),
        createdAt:     (userDoc?.exists ? userDoc.data()?.createdAt : null) ?? null,
      },
    });
  } catch (error) {
    console.error('me error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to load profile' });
  }
}

export async function login(req, res) {
  const mark = createLoginTimer();
  try {
    const emailRaw = req.body?.email;
    const passwordRaw = req.body?.password;
    let idToken = req.body?.idToken;

    if (emailRaw != null && passwordRaw != null) {
      const email = String(emailRaw).trim();
      const password = String(passwordRaw);
      if (!email || !password) {
        recordAuth('loginFail');
        return res.status(400).json({ success: false, message: 'Email and password are required.' });
      }
      try {
        const rest = await firebaseRestSignIn(email, password);
        idToken = rest.idToken;
        mark('firebaseRestSignIn');
      } catch (restErr) {
        recordAuth('loginFail');
        const code = restErr?.code || '';
        if (restErr?.code === 'VALIDATION') {
          return res.status(400).json({ success: false, message: restErr.message || 'Invalid input.' });
        }
        if (restErr?.code === 'AUTH_SERVICE_CONFIG') {
          console.error('[login] FIREBASE_WEB_API_KEY missing');
          return res.status(503).json({ success: false, message: 'Sign-in is temporarily unavailable.' });
        }
        const msg = restErr?.message || 'Invalid email or password.';
        const lower = String(code).toLowerCase();
        const status =
          lower.includes('USER_DISABLED') || lower.includes('disabled') ? 403 : 401;
        return res.status(status).json({ success: false, message: msg });
      }
    }

    if (!idToken || typeof idToken !== 'string') {
      recordAuth('loginFail');
      return res.status(400).json({
        success: false,
        message: 'Email and password are required.',
      });
    }

    const auth = getFirebaseAuth();
    if (!auth) {
      recordAuth('loginFail');
      return res.status(503).json({ success: false, message: 'Account service is temporarily unavailable.' });
    }

    let decoded;
    try {
      decoded = await auth.verifyIdToken(idToken);
    } catch {
      recordAuth('loginFail');
      return res.status(401).json({ success: false, message: 'Invalid or expired session. Try again.' });
    }
    mark('verifyIdToken');

    const uid = decoded.uid;
    let resolvedUser = await auth.getUser(uid);
    const cleanEmail = (decoded.email || resolvedUser.email || '').trim().toLowerCase();
    mark('getUser');

    const db = getFirebaseDb();
    const [creatorPack, supaProfile, firestoreUserSnap] = await Promise.all([
      getUserCreatorStatus(uid),
      _getSupabaseProfile(uid),
      db
        ? db
            .collection('users')
            .doc(uid)
            .get()
            .catch(() => null)
        : Promise.resolve(null),
    ]);
    mark('getUserCreatorStatus+supaProfile');

    let resolvedSupa = supaProfile;
    let emailVerifiedOk = isLoginEmailVerifiedOk(resolvedUser, decoded, resolvedSupa, firestoreUserSnap);

    if (!emailVerifiedOk) {
      const issue = await issueFreshVerificationEmail(
        uid,
        cleanEmail,
        resolvedUser.displayName || (cleanEmail ? cleanEmail.split('@')[0] : 'User')
      );

      if (issue.code === 'ALREADY_VERIFIED') {
        const [ur2, sp2, fs2] = await Promise.all([
          auth.getUser(uid),
          _getSupabaseProfile(uid),
          db
            ? db
                .collection('users')
                .doc(uid)
                .get()
                .catch(() => null)
            : Promise.resolve(null),
        ]);
        emailVerifiedOk = isLoginEmailVerifiedOk(ur2, decoded, sp2, fs2);
        if (emailVerifiedOk) {
          resolvedUser = ur2;
          resolvedSupa = sp2;
        }
      }

      if (!emailVerifiedOk) {
        console.info('[emailVerification] login_denied_email_not_verified', uid, issue.code || '');
        recordAuth('loginFail');

        if (issue.code === 'COOLDOWN') {
          return res.status(403).json({
            success: false,
            code: 'EMAIL_NOT_VERIFIED',
            message: issue.message,
            emailVerified: false,
            verificationEmailSent: false,
            cooldownSeconds: issue.waitSeconds,
          });
        }

        const verificationEmailSent = issue.code === 'SENT';
        const message =
          issue.code === 'LOCAL_LINK' && issue.message
            ? issue.message
            : verificationEmailSent
              ? 'Your account is not verified. A new verification email has been sent.'
              : issue.message || 'Please verify your email before logging in.';

        return res.status(403).json({
          success: false,
          code: 'EMAIL_NOT_VERIFIED',
          message,
          emailVerified: false,
          verificationEmailSent,
          ...(issue.localVerificationUrl ? { localVerificationUrl: issue.localVerificationUrl } : {}),
          ...(issue.emailDeliveryConfigured === false ? { emailDeliveryConfigured: false } : {}),
        });
      }
    }

    const sessionToken = mintSessionToken(uid, cleanEmail);
    mark('mintSessionToken');

    const displayName =
      resolvedUser.displayName || (cleanEmail ? cleanEmail.split('@')[0] : 'User');
    recordAuth('loginOk');
    return res.status(200).json({
      success: true,
      message: 'Login successful',
      uid,
      email: cleanEmail,
      displayName,
      emailVerified: true,
      ...(sessionToken && { sessionToken }),
      userData: {
        email:        cleanEmail,
        name:         displayName,
        avatar:       resolvedSupa.avatar || resolvedUser.photoURL || null,
        creator:      !!creatorPack.creator,
        creatorStatus: creatorPack.creatorStatus || 'none',
        followers:    resolvedSupa.followers    ?? 0,
        following:    resolvedSupa.following    ?? 0,
        tokenBalance: resolvedSupa.tokenBalance ?? 0,
        coinBalance:  resolvedSupa.coinBalance  ?? 0,
        emailVerified: true,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    recordAuth('loginFail');
    return res.status(400).json({ success: false, message: error.message || 'Login failed.' });
  }
}

function verifyEmailHttpStatus(code) {
  if (code === 'USED') return 409;
  if (code === 'DB_ERROR' || code === 'APPLY_FAILED' || code === 'DB_UPDATE' || code === 'SERVICE') return 500;
  if (code === 'NO_DB') return 503;
  return 400;
}

export async function verifyEmail(req, res) {
  try {
    const token = req.params?.token || req.body?.token;
    const wantsRedirect = req.method === 'GET' && !!req.params?.token;
    const front = publicFrontendUrl();

    if (!token || typeof token !== 'string' || !token.trim()) {
      if (wantsRedirect) {
        return res.redirect(302, `${front}/auth/verify-failed?code=MISSING&reason=${encodeURIComponent('Verification token is required.')}`);
      }
      return res.status(400).json({
        success: false,
        code: 'MISSING',
        message: 'Verification token is required.',
      });
    }

    const result = await consumeVerificationToken(token);

    if (wantsRedirect) {
      if (result.ok) {
        return res.redirect(302, `${front}/auth/verified?ok=1`);
      }
      const c = encodeURIComponent(result.code || 'FAILED');
      const r = encodeURIComponent(result.message || 'Verification failed');
      return res.redirect(302, `${front}/auth/verify-failed?code=${c}&reason=${r}`);
    }

    if (!result.ok) {
      const status = verifyEmailHttpStatus(result.code);
      return res.status(status).json({
        success: false,
        code: result.code || 'FAILED',
        message: result.message || 'Verification failed.',
      });
    }
    return res.status(200).json({ success: true, message: result.message || 'Email verified successfully. You can now log in.' });
  } catch (err) {
    console.error('verifyEmail error:', err);
    if (req.method === 'GET' && req.params?.token) {
      return res.redirect(302, `${publicFrontendUrl()}/auth/verify-failed?reason=${encodeURIComponent('Server error')}`);
    }
    return res.status(500).json({ success: false, message: 'Failed to verify email.' });
  }
}

export async function logout(req, res) {
  return res.status(200).json({ success: true, message: 'Signed out.' });
}

export async function forgotPassword(req, res) {
  try {
    const emailRaw = req.body?.email;
    const emailNorm = String(emailRaw || '').trim().toLowerCase();
    if (!emailNorm || !emailNorm.includes('@')) {
      return res.status(400).json({ success: false, message: 'Valid email is required.' });
    }

    const auth = getFirebaseAuth();
    if (!auth) {
      return res.status(503).json({ success: false, message: 'Account service is temporarily unavailable.' });
    }

    let userRecord;
    try {
      userRecord = await auth.getUserByEmail(emailNorm);
    } catch {
      return res.status(200).json({
        success: true,
        message: 'If an account exists for this email, password reset instructions have been sent.',
      });
    }

    const front = publicFrontendUrl();
    const link = await auth.generatePasswordResetLink(emailNorm, {
      url: `${front}/auth/reset-password`,
      handleCodeInApp: false,
    });

    const displayName = userRecord.displayName || emailNorm.split('@')[0];
    await sendPasswordResetEmail({
      to: emailNorm,
      name: displayName,
      resetUrl: link,
    });

    return res.status(200).json({
      success: true,
      message: 'If an account exists for this email, password reset instructions have been sent.',
    });
  } catch (err) {
    console.error('forgotPassword error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Could not process request.' });
  }
}

export async function resetPassword(req, res) {
  try {
    const { oobCode, newPassword } = req.body || {};
    if (!oobCode || typeof oobCode !== 'string') {
      return res.status(400).json({ success: false, message: 'Reset code is required.' });
    }
    if (!newPassword || String(newPassword).length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
    }

    await confirmPasswordResetWithOobCode(String(oobCode).trim(), String(newPassword));
    return res.status(200).json({ success: true, message: 'Password updated. You can sign in with your new password.' });
  } catch (err) {
    const raw = err?.code || err?.message || '';
    const lower = String(raw).toLowerCase();
    if (lower.includes('expired') || lower.includes('invalid_oob_code')) {
      return res.status(400).json({ success: false, message: 'This reset link is invalid or has expired. Request a new one.' });
    }
    console.error('resetPassword error:', err);
    return res.status(400).json({ success: false, message: err.message || 'Could not reset password.' });
  }
}

export async function resendVerificationEmail(req, res) {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ success: false, message: 'Valid email is required.' });
    }

    const emailNorm = email.trim().toLowerCase();

    const auth = getFirebaseAuth();
    if (!auth) {
      return res.status(503).json({ success: false, message: 'Service temporarily unavailable.' });
    }

    let userRecord;
    try {
      userRecord = await auth.getUserByEmail(emailNorm);
    } catch {
      // Don't leak whether the user exists
      return res.status(200).json({ success: true, message: 'If this email is registered and unverified, a new link has been sent.' });
    }

    const uid = userRecord.uid;
    const displayName = userRecord.displayName || emailNorm.split('@')[0];
    const result = await issueFreshVerificationEmail(uid, emailNorm, displayName);

    if (result.code === 'ALREADY_VERIFIED') {
      return res.status(400).json({ success: false, message: result.message });
    }
    if (result.code === 'COOLDOWN') {
      return res.status(429).json({ success: false, message: result.message });
    }
    if (!result.ok) {
      const code = result.code || 'FAILED';
      if (code === 'NO_DB' || code === 'TOKEN_FAIL' || code === 'SEND_FAIL' || code === 'EMAIL_NOT_CONFIGURED') {
        return res.status(503).json({
          success: false,
          message: result.message,
          code,
        });
      }
      return res.status(500).json({ success: false, message: result.message || 'Failed to send verification email.' });
    }

    return res.status(200).json({
      success: true,
      message: result.message,
      ...(result.localVerificationUrl ? { localVerificationUrl: result.localVerificationUrl } : {}),
      ...(result.emailDeliveryConfigured === false ? { emailDeliveryConfigured: false } : {}),
    });
  } catch (err) {
    console.error('resendVerificationEmail error:', err);
    return res.status(500).json({ success: false, message: 'Failed to send verification email.' });
  }
}

export async function google(req, res) {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({ success: false, message: 'idToken is required.' });
    }

    const auth = getFirebaseAuth();
    const db   = getFirebaseDb();
    if (!auth || !db) {
      return res.status(503).json({ success: false, message: 'Account service is temporarily unavailable.' });
    }

    let decoded;
    try {
      decoded = await auth.verifyIdToken(idToken);
    } catch (err) {
      return res.status(401).json({ success: false, message: 'Invalid or expired Google token' });
    }

    const cleanEmail = decoded.email?.toLowerCase();
    const name = decoded.name || decoded.displayName || (cleanEmail ? cleanEmail.split('@')[0] : 'User');
    const photoURL = decoded.picture || decoded.photoURL;

    // Check if user exists in Firebase Auth; if not, create
    let userRecord;
    try {
      userRecord = await auth.getUserByEmail(cleanEmail);
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        userRecord = await auth.createUser({
          email: cleanEmail,
          displayName: name,
          photoURL: photoURL || undefined,
        });
      } else {
        throw err;
      }
    }

    const uid = userRecord.uid;

    await db.collection('users').doc(uid).set(
      {
        uid,
        name,
        email: cleanEmail,
        displayName: name,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        creatorStatus: 'none',
        avatar: photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${cleanEmail}`,
        followers: 0,
        following: 0,
        googleSignIn: true,
        emailVerified: !!(decoded.email_verified === true || decoded.emailVerified === true),
      },
      { merge: true }
    );

    const avatarForRow = photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(cleanEmail || uid)}`;
    const googleEmailVerified =
      decoded.email_verified === true || decoded.emailVerified === true;
    const nowGoogle = new Date().toISOString();
    void insertUser({
      id: uid,
      username: name.replace(/\s+/g, '_').toLowerCase(),
      display_name: name,
      full_name: name,
      email: cleanEmail || '',
      email_verified: googleEmailVerified,
      creator: false,
      role: 'user',
      created_at: nowGoogle,
      updated_at: nowGoogle,
      avatar: avatarForRow,
      avatar_url: avatarForRow,
    }).catch((e) => console.warn('google insertUser:', e?.message || e));

    const [userDoc, creatorStatusRow, googleCustomToken] = await Promise.all([
      db.collection('users').doc(uid).get(),
      getUserCreatorStatus(uid),
      auth.createCustomToken(uid).catch((e) => {
        console.warn('Google login: custom token failed', e?.message || e);
        return null;
      }),
    ]);

    const userData = userDoc.exists ? userDoc.data() : {};
    userData.creator = !!creatorStatusRow.creator;
    userData.creatorStatus = creatorStatusRow.creatorStatus || 'none';

    const sessionToken = mintSessionToken(uid, cleanEmail);

    return res.status(200).json({
      success: true,
      message: 'Google login successful',
      uid,
      email: cleanEmail,
      displayName: name,
      ...(googleCustomToken && { token: googleCustomToken }),
      ...(sessionToken && { sessionToken }),
      userData,
    });
  } catch (error) {
    console.error('Google login error:', error);
    return res.status(400).json({ success: false, message: error.message || 'Google login failed.' });
  }
}
