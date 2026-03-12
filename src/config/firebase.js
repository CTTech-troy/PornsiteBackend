import admin from 'firebase-admin';
import dotenv from 'dotenv';

dotenv.config();

// Initialize Firebase Admin SDK using service account key from environment
const serviceAccount = (() => {
  try {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY || '{}');
  } catch (e) {
    console.warn('Invalid JSON in FIREBASE_SERVICE_ACCOUNT_KEY:', e && e.message ? e.message : e);
    return {};
  }
})();

let firebaseInitialized = false;
let auth = null;
let db = null;
let rtdb = null;

function makeNotInitProxy(name, errMessage) {
  const errmsg = errMessage || `Firebase ${name} not initialized`;
  return new Proxy({}, {
    get() {
      throw new Error(errmsg);
    },
    apply() {
      throw new Error(errmsg);
    }
  });
}

try {
  const hasCred = Boolean(serviceAccount && serviceAccount.client_email && serviceAccount.private_key);
  const hasDbUrl = Boolean(process.env.FIREBASE_DATABASE_URL);
  if (!hasCred || !hasDbUrl) {
    console.warn('Skipping Firebase initialization: missing service account or FIREBASE_DATABASE_URL');
  } else {
    try {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL,
      });
      db = admin.firestore();
      auth = admin.auth();
      rtdb = admin.database();
      firebaseInitialized = true;
    } catch (initErr) {
      // Network or credential errors (e.g., ETIMEDOUT) can happen here; log and continue with proxies
      console.warn('Firebase Admin initialization failed:', initErr && initErr.message ? initErr.message : initErr);
    }
  }
} catch (err) {
  console.warn('Unexpected error during Firebase setup:', err && err.message ? err.message : err);
}

if (!firebaseInitialized) {
  const note = 'Firebase Admin SDK is not initialized. Calls to auth/db/rtdb will throw until the service is available.';
  auth = makeNotInitProxy('Auth', note);
  db = makeNotInitProxy('Firestore', note);
  rtdb = makeNotInitProxy('RTDB', note);
}

export { auth, db, admin, rtdb, firebaseInitialized };
