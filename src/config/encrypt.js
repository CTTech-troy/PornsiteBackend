import crypto from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 16;
const TAG_LEN = 16;
const KEY_LEN = 32;
const SALT = 'creator_app_v1';

function getKey() {
  const secret = process.env.CREATOR_DATA_SECRET || process.env.ENCRYPTION_KEY;
  if (!secret || secret.length < 16) return null;
  return crypto.scryptSync(secret, SALT, KEY_LEN);
}

export function encryptApplicationData(plain) {
  const key = getKey();
  if (!key) return plain;

  if (plain === null || plain === undefined) return plain;
  if (typeof plain !== 'object') return plain;

  const sensitiveKeys = new Set([
    'firstName', 'lastName', 'email', 'phone', 'houseDetails', 'streetAddress',
    'city', 'lga', 'state', 'country', 'idType', 'idNumber', 'bankName',
    'accountNumber', 'accountName', 'bvn', 'mobileProvider', 'mobileNumber', 'mobileAccountName',
  ]);

  const out = { ...plain };
  for (const k of Object.keys(out)) {
    if (!sensitiveKeys.has(k)) continue;
    const val = out[k];
    if (val == null || val === '') continue;
    const str = typeof val === 'string' ? val : JSON.stringify(val);
    try {
      const iv = crypto.randomBytes(IV_LEN);
      const cipher = crypto.createCipheriv(ALGO, key, iv);
      const enc = Buffer.concat([cipher.update(str, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      out[k] = 'enc:' + Buffer.concat([iv, tag, enc]).toString('base64');
    } catch (err) {
      // if encryption fails, do not store plaintext; leave key out or store redacted
      out[k] = '[encrypted]';
    }
  }
  return out;
}

export function decryptApplicationData(encrypted) {
  const key = getKey();
  if (!key) return encrypted;

  if (encrypted === null || typeof encrypted !== 'object') return encrypted;

  const out = { ...encrypted };
  for (const k of Object.keys(out)) {
    const val = out[k];
    if (typeof val !== 'string' || !val.startsWith('enc:')) continue;
    try {
      const buf = Buffer.from(val.slice(4), 'base64');
      const iv = buf.subarray(0, IV_LEN);
      const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
      const enc = buf.subarray(IV_LEN + TAG_LEN);
      const decipher = crypto.createDecipheriv(ALGO, key, iv);
      decipher.setAuthTag(tag);
      out[k] = decipher.update(enc) + decipher.final('utf8');
    } catch (err) {
      out[k] = '';
    }
  }
  return out;
}
