import { supabase, isConfigured } from '../config/supabase.js';
import { getFirebaseAuth } from '../config/firebase.js';
import { isEmailVerifiedFlag } from '../services/emailVerificationService.js';

const CODE = 'EMAIL_NOT_VERIFIED';
const MESSAGE = 'Please verify your email before logging in.';

export async function requireVerifiedEmail(req, res, next) {
  const uid = req.uid;
  if (!uid) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  if (isConfigured() && supabase) {
    const { data } = await supabase.from('users').select('email_verified').eq('id', uid).maybeSingle();
    if (isEmailVerifiedFlag(data?.email_verified) === true) {
      return next();
    }
  }

  try {
    const auth = getFirebaseAuth();
    if (auth) {
      const r = await auth.getUser(uid);
      if (r.emailVerified === true) {
        return next();
      }
    }
  } catch {
    /* fall through to 403 */
  }

  return res.status(403).json({ success: false, code: CODE, message: MESSAGE });
}
