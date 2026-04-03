import { auth, db, rtdb } from '../config/firebase.js';
import { supabase } from '../config/supabase.js';
import { insertUser, insertCreatorApplication, getUserCreatorStatus, updateUserCreatorStatus, updateUserWithCreatorApplication, insertMedia } from '../config/dbFallback.js';
import { encryptApplicationData } from '../config/encrypt.js';
import { v4 as uuidv4 } from 'uuid';
import { upsertCreator } from './creator.controller.js';
import fetch from 'node-fetch';
import { mintSessionToken, resolveUidFromBearerToken } from '../utils/sessionToken.js';
import { verifyFirebasePassword } from '../utils/firebasePasswordVerify.js';

export async function signup(req, res) {
  try {
    const { name, email, password } = req.body;

    // Validate input
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Name is required.' });
    }
    if (!email || !email.trim()) {
      return res.status(400).json({ success: false, message: 'Email is required.' });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
    }

    // Create user in Firebase Auth only. Do NOT create Firestore or Supabase records yet.
    // Age consent and further verification must be completed via `/age-consent` before
    // the app-level user records are created.
    const userRecord = await auth.createUser({
      email: email.trim().toLowerCase(),
      password,
      displayName: name.trim(),
    });

    const uid = userRecord.uid;
    const emailNorm = email.trim().toLowerCase();

    const userPayload = {
      id: uid,
      username: name.trim().replace(/\s+/g, '_').toLowerCase(),
      creator: false,
      created_at: new Date().toISOString(),
    };

    void db
      .collection('users')
      .doc(uid)
      .set({
        uid,
        name: name.trim(),
        email: emailNorm,
        displayName: name.trim(),
        emailVerified: userRecord.emailVerified || false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        creatorStatus: 'none',
        avatar: userRecord.photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${email}`,
        followers: 0,
        following: 0,
      })
      .catch((dbErr) => {
        console.error('Firestore user stub on signup:', dbErr?.message || dbErr);
      });

    void insertUser(userPayload).catch((err) => {
      console.error('insertUser on signup:', err?.message || err);
    });

    const sessionToken = mintSessionToken(uid, emailNorm);
    let customToken;
    try {
      customToken = await auth.createCustomToken(uid);
    } catch (tokenErr) {
      console.error('createCustomToken on signup:', tokenErr?.message || tokenErr);
    }

    return res.status(201).json({
      success: true,
      uid,
      email: emailNorm,
      displayName: name.trim(),
      emailVerified: userRecord.emailVerified || false,
      ...(customToken && { token: customToken }),
      ...(sessionToken && { sessionToken }),
    });
  } catch (error) {
    console.error('Signup error:', error);

    // Handle common Firebase Auth errors
    let message = error.message || 'Signup failed.';
    if (error.code === 'auth/email-already-exists') message = 'Email already registered.';
    if (error.code === 'auth/invalid-email') message = 'Invalid email format.';
    if (error.code === 'auth/weak-password') message = 'Password is too weak (min 8 chars).';

    return res.status(400).json({ success: false, message });
  }
}

// Submit age consent (creates app user records after verifying ID token)
export async function submitAgeConsent(req, res) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    const idToken = authHeader.slice(7);
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
      emailVerified: userRecord.emailVerified || false,
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
      const userPayload = {
        id: uid,
        username: displayName.replace(/\s+/g, '_').toLowerCase(),
        creator: false,
        created_at: new Date().toISOString(),
      };
      const res = await insertUser(userPayload);
      console.log(`insertUser result:`, res && res.source ? res.source : res);
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
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    const bearer = authHeader.slice(7);
    const uid = await resolveUidFromBearerToken(bearer);
    if (!uid) {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
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
      for (const file of files) {
        try {
          const filename = `${uid}/${Date.now()}_${(file.originalname || 'attachment').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
          const { data, error } = await supabase.storage.from(bucket).upload(filename, file.buffer, { contentType: file.mimetype });
          if (error) {
            console.warn('Supabase upload error for creator attachment:', error.message || error);
            // continue without failing entire request
            continue;
          }
          const publicUrl = `${process.env.SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/public/${bucket}/${encodeURIComponent(data.path)}`;
          attachments.push({ name: file.originalname, path: data.path, url: publicUrl, contentType: file.mimetype });

          // persist a media row to fallback DB for discovery
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
    } catch (fileErr) {
      console.warn('Error processing attached files:', fileErr && fileErr.message ? fileErr.message : fileErr);
    }

    // Attach attachments list to application data
    if (attachments.length) applicationData.attachments = attachments;

    // Encrypt sensitive fields before storing (do not log or expose PII)
    const dataToStore = encryptApplicationData({ ...applicationData });

    // Store application with status 'pending' until admin approves
    const payload = {
      id: uuidv4(),
      user_id: uid,
      data: dataToStore,
      status: 'pending',
      created_at: new Date().toISOString(),
    };
    try {
      await insertCreatorApplication(payload);
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

    // Firestore: save user details and verified = pending
    await db.collection('users').doc(uid).set({
      creatorStatus: 'pending',
      creatorApplicationId: payload.id,
      creator_application: dataToStore,
      verified: 'pending',
    }, { merge: true });

    // RTDB: store reference only; sensitive data is in encrypted payload in DB
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

    // Supabase creators row (no PII in profile)
    try {
      const creatorProfile = { verified: false, profile: {}, applied_at: new Date().toISOString() };
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
        await fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payloadForAdmin),
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

// Admin approves creator
export async function approveCreator(req, res) {
  try {
    const { user_id, approve } = req.body; // approve=true/false
    const adminSecret = req.headers['x-admin-secret'];
    if (adminSecret !== process.env.ADMIN_SECRET) return res.status(401).json({ success: false, message: 'Not authorized' });
    if (!user_id) return res.status(400).json({ success: false, message: 'user_id required' });

    try {
      await updateUserCreatorStatus(user_id, approve);
    } catch (err) {
      console.warn('Fallback DB update creator status:', err?.message || err);
    }

    // Firestore: admin confirmed — set approved so user gets creator features
    await db.collection('users').doc(user_id).set({ creatorStatus: approve ? 'approved' : 'rejected' }, { merge: true });

    return res.status(200).json({ success: true, message: 'Creator status updated' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

// Media upload: accepts file via multer and uploads to Supabase Storage
export async function uploadMedia(req, res) {
  try {
    const file = req.file;
    const { uid, type = 'video', title = '' } = req.body; // uid should be provided by client
    if (!file) return res.status(400).json({ success: false, message: 'File required' });
    if (!uid) return res.status(400).json({ success: false, message: 'uid required' });

    const bucket = type === 'image' ? (process.env.SUPABASE_IMAGE_BUCKET || 'images') : (process.env.SUPABASE_VIDEO_BUCKET || 'videos');
    const filename = `${uid}/${Date.now()}_${file.originalname}`;

    const { data, error } = await supabase.storage.from(bucket).upload(filename, file.buffer, { contentType: file.mimetype });
    if (error) throw error;

    const publicUrl = `${process.env.SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/public/${bucket}/${encodeURIComponent(data.path)}`;

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

    return res.status(201).json({ success: true, url: publicUrl, path: data.path });
  } catch (err) {
    console.error('uploadMedia error', err);
    return res.status(500).json({ success: false, message: err.message || 'Upload failed' });
  }
}

export async function resendVerification(req, res) {
  try {
    const { email } = req.body;
    if (!email || !email.trim()) return res.status(400).json({ success: false, message: 'Email is required.' });

    const cleanEmail = email.trim().toLowerCase();
    // Ensure user exists
    let userRecord;
    try {
      userRecord = await auth.getUserByEmail(cleanEmail);
    } catch (err) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    if (userRecord.emailVerified) {
      return res.status(400).json({ success: false, message: 'Email already verified.' });
    }

    const verificationLink = await auth.generateEmailVerificationLink(cleanEmail);
    console.log(`Verification link (no-mailer) for ${cleanEmail}: ${verificationLink}`);
    const resp = { success: true, message: 'Email sending is disabled on this server; verification link generated.' };
    if (process.env.NODE_ENV !== 'production') resp.verificationLink = verificationLink;
    return res.status(200).json(resp);
  } catch (error) {
    console.error('Resend verification error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to resend verification.' });
  }
}

export async function login(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !email.trim()) {
      return res.status(400).json({ success: false, message: 'Email is required.' });
    }
    if (!password) {
      return res.status(400).json({ success: false, message: 'Password is required.' });
    }

    const cleanEmail = email.trim().toLowerCase();

    let uid;
    try {
      const verified = await verifyFirebasePassword(cleanEmail, password);
      uid = verified.localId;
    } catch (verifyErr) {
      if (verifyErr.code === 'config') {
        return res.status(503).json({
          success: false,
          message: 'Server misconfigured: set FIREBASE_WEB_API_KEY (same Web API key as the frontend).',
        });
      }
      if (verifyErr.code === 'auth/invalid-credential') {
        return res.status(401).json({ success: false, message: verifyErr.message || 'Invalid email or password.' });
      }
      if (verifyErr.code === 'auth/too-many-requests') {
        return res.status(429).json({ success: false, message: verifyErr.message || 'Too many attempts.' });
      }
      return res.status(401).json({ success: false, message: verifyErr.message || 'Login failed.' });
    }

    const [userRecord, userDoc, creatorPack] = await Promise.all([
      auth.getUser(uid),
      db.collection('users').doc(uid).get(),
      getUserCreatorStatus(uid),
    ]);

    const userData = userDoc.exists ? userDoc.data() : {};
    userData.creator = !!creatorPack.creator;
    userData.creatorStatus = creatorPack.creatorStatus || 'none';

    let token;
    try {
      token = await auth.createCustomToken(uid);
    } catch (tokenErr) {
      console.warn('Login: custom token failed', tokenErr?.message || tokenErr);
    }

    const sessionToken = mintSessionToken(uid, cleanEmail);
    return res.status(200).json({
      success: true,
      message: 'Login successful',
      uid,
      email: cleanEmail,
      displayName: userRecord.displayName || userData.name || cleanEmail.split('@')[0],
      emailVerified: !!userRecord.emailVerified,
      ...(token && { token }),
      ...(sessionToken && { sessionToken }),
      userData: {
        ...userData,
        email: cleanEmail,
      },
    });
  } catch (error) {
    console.error('Login error:', error);

    let message = error.message || 'Login failed.';
    if (error.code === 'auth/user-not-found') message = 'User not found.';
    if (error.code === 'auth/invalid-email') message = 'Invalid email format.';

    return res.status(400).json({ success: false, message });
  }
}

export async function google(req, res) {
  try {
    const { email, displayName, photoURL } = req.body;

    if (!email || !email.trim()) {
      return res.status(400).json({ success: false, message: 'Email is required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const name = displayName || cleanEmail.split('@')[0];

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
        emailVerified: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        creatorStatus: 'none',
        avatar: photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${cleanEmail}`,
        followers: 0,
        following: 0,
        googleSignIn: true,
      },
      { merge: true }
    );

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
      emailVerified: true,
      ...(googleCustomToken && { token: googleCustomToken }),
      ...(sessionToken && { sessionToken }),
      userData,
    });
  } catch (error) {
    console.error('Google login error:', error);
    return res.status(400).json({ success: false, message: error.message || 'Google login failed.' });
  }
}


export async function verifyEmail(req, res) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Missing or invalid token' });
    }

    const idToken = authHeader.slice(7);
    const decodedToken = await auth.verifyIdToken(idToken);
    const uid = decodedToken.uid;

    const user = await auth.getUser(uid);

    // Generate a verification link and return it (no email sending on server)
    const verificationLink = await auth.generateEmailVerificationLink(user.email);
    console.log(`Verification link (no-mailer) for ${user.email}: ${verificationLink}`);
    return res.status(200).json({
      success: true,
      message: 'Verification link generated (email sending disabled on server)',
      verificationLink,
    });
  } catch (error) {
    console.error('Verify email error:', error);
    return res.status(400).json({ success: false, message: error.message });
  }
}
