import jwt from 'jsonwebtoken';

const RESET_AUDIENCE = 'xstream-password-reset';
const RESET_ISSUER = 'xstream-api';
const RESET_PURPOSE = 'password_reset';

function getPasswordResetSecret() {
  const secret =
    process.env.PASSWORD_RESET_SECRET ||
    process.env.JWT_SECRET ||
    process.env.SESSION_JWT_SECRET;
  if (secret) return secret;
  if (String(process.env.NODE_ENV || '').toLowerCase() !== 'production') {
    return 'xstream-dev-password-reset-secret';
  }
  return null;
}

function getPasswordResetTtl() {
  return process.env.PASSWORD_RESET_TOKEN_TTL || '30m';
}

export function createPasswordResetToken({ uid, email }) {
  const secret = getPasswordResetSecret();
  if (!secret) {
    const err = new Error('Password reset is not configured.');
    err.code = 'PASSWORD_RESET_CONFIG';
    throw err;
  }

  const userId = String(uid || '').trim();
  const emailNorm = String(email || '').trim().toLowerCase();
  if (!userId || !emailNorm.includes('@')) {
    const err = new Error('Invalid password reset request.');
    err.code = 'PASSWORD_RESET_INVALID';
    throw err;
  }

  return jwt.sign(
    {
      purpose: RESET_PURPOSE,
      email: emailNorm,
    },
    secret,
    {
      subject: userId,
      expiresIn: getPasswordResetTtl(),
      audience: RESET_AUDIENCE,
      issuer: RESET_ISSUER,
    }
  );
}

export function looksLikeAppPasswordResetToken(token) {
  return String(token || '').trim().split('.').length === 3;
}

export function verifyPasswordResetToken(token) {
  const secret = getPasswordResetSecret();
  if (!secret) {
    return { ok: false, code: 'PASSWORD_RESET_CONFIG', message: 'Password reset is temporarily unavailable.' };
  }

  try {
    const payload = jwt.verify(String(token || '').trim(), secret, {
      audience: RESET_AUDIENCE,
      issuer: RESET_ISSUER,
    });
    if (payload?.purpose !== RESET_PURPOSE || !payload?.sub) {
      return { ok: false, code: 'INVALID', message: 'This reset link is invalid or has expired. Request a new one.' };
    }
    return {
      ok: true,
      uid: String(payload.sub),
      email: String(payload.email || '').trim().toLowerCase(),
    };
  } catch (err) {
    const expired = err?.name === 'TokenExpiredError';
    return {
      ok: false,
      code: expired ? 'EXPIRED' : 'INVALID',
      message: expired
        ? 'This reset link has expired. Request a new one.'
        : 'This reset link is invalid or has expired. Request a new one.',
    };
  }
}
