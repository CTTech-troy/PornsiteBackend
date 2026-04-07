import crypto from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 16;
const TAG_LEN = 16;
const KEY_LEN = 32;
const SALT_LEN = 16; // SEC-07: random salt per encryption operation

function deriveKey(secret, salt) {
  return crypto.scryptSync(secret, salt, KEY_LEN);
}

function getSecret() {
  const secret = process.env.CREATOR_DATA_SECRET || process.env.ENCRYPTION_KEY;
  if (!secret || secret.length < 16) return null;
  return secret;
}

/**
 * Encrypt sensitive fields in an application data object.
 * Each field gets its own random salt + IV, prepended to the ciphertext.
 * Format: "enc:" + base64( salt[16] + iv[16] + authTag[16] + ciphertext )
 */
export function encryptApplicationData(plain) {
  const secret = getSecret();
  if (!secret) return plain;

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
      const salt = crypto.randomBytes(SALT_LEN);
      const iv = crypto.randomBytes(IV_LEN);
      const key = deriveKey(secret, salt);
      const cipher = crypto.createCipheriv(ALGO, key, iv);
      const enc = Buffer.concat([cipher.update(str, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      // Prepend salt so each encryption uses a unique derived key
      out[k] = 'enc:' + Buffer.concat([salt, iv, tag, enc]).toString('base64');
    } catch (err) {
      // if encryption fails, do not store plaintext; leave key redacted
      out[k] = '[encrypted]';
    }
  }
  return out;
}

/**
 * Decrypt sensitive fields. Supports both new format (with per-field salt)
 * and legacy format (static salt "creator_app_v1") for backward compatibility.
 */
export function decryptApplicationData(encrypted) {
  const secret = getSecret();
  if (!secret) return encrypted;

  if (encrypted === null || typeof encrypted !== 'object') return encrypted;

  const out = { ...encrypted };
  for (const k of Object.keys(out)) {
    const val = out[k];
    if (typeof val !== 'string' || !val.startsWith('enc:')) continue;
    try {
      const buf = Buffer.from(val.slice(4), 'base64');

      // New format: salt(16) + iv(16) + tag(16) + ciphertext = minimum 48 bytes + data
      // Legacy format: iv(16) + tag(16) + ciphertext = minimum 32 bytes + data
      // Detect by checking total length — new format is 16 bytes longer for the salt
      let salt, iv, tag, enc;
      if (buf.length > SALT_LEN + IV_LEN + TAG_LEN) {
        // Try new format first (with random salt)
        salt = buf.subarray(0, SALT_LEN);
        iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN);
        tag = buf.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
        enc = buf.subarray(SALT_LEN + IV_LEN + TAG_LEN);

        try {
          const key = deriveKey(secret, salt);
          const decipher = crypto.createDecipheriv(ALGO, key, iv);
          decipher.setAuthTag(tag);
          out[k] = decipher.update(enc) + decipher.final('utf8');
          continue; // success with new format
        } catch {
          // Fall through to try legacy format
        }
      }

      // Legacy format: static salt "creator_app_v1"
      const legacyKey = crypto.scryptSync(secret, 'creator_app_v1', KEY_LEN);
      iv = buf.subarray(0, IV_LEN);
      tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
      enc = buf.subarray(IV_LEN + TAG_LEN);
      const decipher = crypto.createDecipheriv(ALGO, legacyKey, iv);
      decipher.setAuthTag(tag);
      out[k] = decipher.update(enc) + decipher.final('utf8');
    } catch (err) {
      out[k] = '';
    }
  }
  return out;
}
