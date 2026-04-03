import path from 'path';
import admin from 'firebase-admin';
import dotenv from 'dotenv';

dotenv.config();

const gacRaw = (process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
if (gacRaw && !path.isAbsolute(gacRaw)) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(process.cwd(), gacRaw);
}

const serviceAccount = (() => {
  try {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY || '{}');
  } catch (e) {
    console.warn('Invalid JSON in FIREBASE_SERVICE_ACCOUNT_KEY:', e && e.message ? e.message : e);
    return {};
  }
})();

const useApplicationDefault = () => {
  const p = (process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  return p.length > 0;
};

const hasInlineServiceAccount = Boolean(
  serviceAccount && serviceAccount.client_email && serviceAccount.private_key
);

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
  const hasDbUrl = Boolean(process.env.FIREBASE_DATABASE_URL);
  const canInit = hasDbUrl && (hasInlineServiceAccount || useApplicationDefault());
  if (!hasDbUrl) {
    console.warn('Skipping Firebase initialization: missing FIREBASE_DATABASE_URL');
  } else if (!canInit) {
    console.warn(
      'Skipping Firebase initialization: set FIREBASE_SERVICE_ACCOUNT_KEY (JSON string) or GOOGLE_APPLICATION_CREDENTIALS (path to service account .json)'
    );
  } else {
    try {
      if (hasInlineServiceAccount) {
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
          databaseURL: process.env.FIREBASE_DATABASE_URL,
        });
      } else {
        admin.initializeApp({
          credential: admin.credential.applicationDefault(),
          databaseURL: process.env.FIREBASE_DATABASE_URL,
        });
      }
      db = admin.firestore();
      auth = admin.auth();
      rtdb = admin.database();
      firebaseInitialized = true;
    } catch (initErr) {
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
