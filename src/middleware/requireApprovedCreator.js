import { getFirebaseDb } from '../config/firebase.js';
import { supabase, isConfigured } from '../config/supabase.js';

async function isApprovedCreator(uid) {
  if (!uid) return false;

  if (isConfigured() && supabase) {
    try {
      const { data } = await supabase
        .from('users')
        .select('creator, verified')
        .eq('id', uid)
        .maybeSingle();
      if (data?.creator === true) return true;
      const v = data?.verified;
      if (v === true || v === 'approved') return true;
    } catch (_) {}
  }

  const db = getFirebaseDb();
  if (db) {
    try {
      const doc = await db.collection('users').doc(uid).get();
      const d = doc.data() || {};
      if (d.creator === true || d.creatorStatus === 'approved') return true;
    } catch (_) {}
  }

  return false;
}

export async function requireApprovedCreator(req, res, next) {
  if (!req.uid) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
  const ok = await isApprovedCreator(req.uid);
  if (!ok) {
    return res.status(403).json({
      success: false,
      code: 'CREATOR_REQUIRED',
      message: 'Approved creator access required.',
    });
  }
  return next();
}
