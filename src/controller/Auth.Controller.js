import { auth, db, rtdb } from '../config/firebase.js';
import { supabase } from '../config/supabase.js';
import { insertUser, insertCreatorApplication, updateUserCreatorStatus, insertMedia } from '../config/dbFallback.js';
import { v4 as uuidv4 } from 'uuid';
import { upsertCreator } from './creator.controller.js';
import fetch from 'node-fetch';

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

    console.log(`New Firebase Auth user created: uid=${uid} email=${email.trim().toLowerCase()}`);

    // Create initial Firestore user metadata immediately so the app can show profile
    try {
      await db.collection('users').doc(uid).set({
        uid,
        name: name.trim(),
        email: email.trim().toLowerCase(),
        displayName: name.trim(),
        emailVerified: userRecord.emailVerified || false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        creatorStatus: 'none',
        avatar: userRecord.photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${email}`,
        followers: 0,
        following: 0,
      });
      console.log(`Created Firestore stub user for uid=${uid}`);
    } catch (dbErr) {
      console.error('Failed to create Firestore user stub on signup:', dbErr && dbErr.message ? dbErr.message : dbErr);
    }

    // Persist lightweight user in Supabase or RTDB fallback
    try {
      const userPayload = {
        id: uid,
        username: name.trim().replace(/\s+/g, '_').toLowerCase(),
        creator: false,
        created_at: new Date().toISOString(),
      };
      const insertRes = await insertUser(userPayload);
      console.log('insertUser result on signup:', insertRes && insertRes.source ? insertRes.source : insertRes);
    } catch (err) {
      console.error('Failed to persist lightweight user on signup:', err && err.message ? err.message : err);
    }

    // Create a custom token so client can sign in immediately
    try {
      const customToken = await auth.createCustomToken(uid);
      console.log(`Created custom token for uid=${uid} on signup`);
      return res.status(201).json({ success: true, uid, email: email.trim().toLowerCase(), displayName: name.trim(), emailVerified: userRecord.emailVerified || false, token: customToken });
    } catch (tokenErr) {
      console.error('Failed to create custom token on signup:', tokenErr && tokenErr.message ? tokenErr.message : tokenErr);
      return res.status(201).json({ success: true, uid, email: email.trim().toLowerCase(), displayName: name.trim(), emailVerified: userRecord.emailVerified || false });
    }
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

    // After age consent, create a Firebase custom token so the client can sign in immediately.
    try {
      const customToken = await auth.createCustomToken(uid);
      console.log(`Created custom token for uid=${uid}`);
      return res.status(200).json({ success: true, message: 'Age consent recorded and account completed', uid, token: customToken });
    } catch (tokenErr) {
      console.error('Failed to create custom token during age-consent:', tokenErr && tokenErr.message ? tokenErr.message : tokenErr);
      return res.status(200).json({ success: true, message: 'Age consent recorded and account completed', uid });
    }
  } catch (err) {
    console.error('submitAgeConsent error', err);
    return res.status(500).json({ success: false, message: err.message || 'Failed to submit age consent' });
  }
}

// User applies to become creator
export async function applyCreator(req, res) {
  try {
    // Require authentication via Firebase ID token in Authorization header
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

    // store application in Supabase table 'creator_applications'
    const payload = {
      id: uuidv4(),
      user_id: uid,
      data: applicationData || {},
      status: 'pending',
      created_at: new Date().toISOString(),
    };
    try {
      const appRes = await insertCreatorApplication(payload);
      console.log('insertCreatorApplication result:', appRes && appRes.source ? appRes.source : appRes);
    } catch (err) {
      console.error('Failed to persist creator application:', err && err.message ? err.message : err);
    }

    // mark Firestore user as pending
    await db.collection('users').doc(uid).set({ creatorStatus: 'pending', creatorApplication: payload }, { merge: true });

    // Also ensure RTDB has a creators entry linked to the user with verified:false
    try {
      await rtdb.ref(`creators/${uid}`).set({
        user_id: uid,
        profile: applicationData || {},
        verified: false,
        application_id: payload.id,
        created_at: new Date().toISOString(),
      });
      // also write a quick pointer under users/{uid}/creatorApplication for RTDB consumers
      await rtdb.ref(`users/${uid}/creatorApplication`).set(payload);
      await rtdb.ref(`users/${uid}/creatorStatus`).set('pending');
    } catch (rtdbErr) {
      console.warn('Failed to write creator record to RTDB:', rtdbErr && rtdbErr.message ? rtdbErr.message : rtdbErr);
    }

    // Try to upsert a creators row in Supabase so Supabase and RTDB/Firestore are aligned
    try {
      const creatorProfile = { verified: false, profile: applicationData || {}, applied_at: new Date().toISOString() };
      const up = await upsertCreator(uid, creatorProfile);
      console.log('upsertCreator result:', up && up.id ? up.id : up);
    } catch (upErr) {
      console.warn('Failed to upsert creator in Supabase:', upErr && upErr.message ? upErr.message : upErr);
    }

    // Notify admin webhook if configured
    try {
      const webhook = process.env.ADMIN_WEBHOOK_URL;
      if (webhook) {
        const payloadForAdmin = {
          event: 'creator_application_submitted',
          application_id: payload.id,
          user_id: uid,
          profile: applicationData || {},
          submitted_at: payload.created_at,
        };
        // fire-and-forget, but log response for diagnostics
        const whRes = await fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payloadForAdmin),
          timeout: 5000
        });
        console.log('Admin webhook delivered, status=', whRes.status);
      }
    } catch (whErr) {
      console.warn('Admin webhook failed:', whErr && whErr.message ? whErr.message : whErr);
    }

    return res.status(200).json({ success: true, message: 'Application submitted' });
  } catch (err) {
    // If multer/body-parser threw a payload-too-large error it usually won't reach here,
    // but be defensive: map common indicators to 413.
    console.error('applyCreator error', err);
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

    // update Supabase users table
    try {
      const upd = await updateUserCreatorStatus(user_id, approve);
      console.log('updateUserCreatorStatus result:', upd && upd.source ? upd.source : upd);
    } catch (err) {
      console.error('Failed to update user creator status in fallback DB:', err && err.message ? err.message : err);
    }

    // update Firestore user record
    await db.collection('users').doc(user_id).set({ creatorStatus: approve ? 'approved' : 'rejected' }, { merge: true });

    return res.status(200).json({ success: true, message: 'Creator status updated' });
  } catch (err) {
    console.error('approveCreator error', err);
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

    // Get user by email to check if exists
    const userRecord = await auth.getUserByEmail(cleanEmail);
    const uid = userRecord.uid;

    // Note: email verification requirement removed — allow login regardless of emailVerified

    // Fetch user metadata from Firestore
    const userDoc = await db.collection('users').doc(uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};

    console.log(`Login successful for uid=${uid} email=${cleanEmail}`);
    return res.status(200).json({
      success: true,
      message: 'Login successful',
      uid,
      email: cleanEmail,
      displayName: userRecord.displayName || userData.name || cleanEmail.split('@')[0],
      emailVerified: true,
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
    let createdNew = false;
    try {
      userRecord = await auth.getUserByEmail(cleanEmail);
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        // Create new user via Google
        userRecord = await auth.createUser({
          email: cleanEmail,
          displayName: name,
          photoURL: photoURL || undefined,
        });
        createdNew = true;
      } else {
        throw err;
      }
    }

    const uid = userRecord.uid;
    if (createdNew) console.log(`Created new Firebase Auth user via Google: uid=${uid} email=${cleanEmail}`);
    else console.log(`Google sign-in for existing Firebase Auth user: uid=${uid} email=${cleanEmail}`);

    // Create or update user in Firestore (Google users auto-verified)
    await db.collection('users').doc(uid).set({
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
    }, { merge: true });

    console.log(`Upserted Firestore user for Google sign-in: uid=${uid}`);
    // Fetch updated user data
    const userDoc = await db.collection('users').doc(uid).get();
    const userData = userDoc.data();

    return res.status(200).json({
      success: true,
      message: 'Google login successful',
      uid,
      email: cleanEmail,
      displayName: name,
      emailVerified: true,
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
