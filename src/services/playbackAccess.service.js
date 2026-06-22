import crypto from 'crypto';
import { supabase } from '../config/supabase.js';
import { getFirebaseRtdb } from '../config/firebase.js';
import { isMissingDbFeature } from './revenueCalculation.service.js';

const TOKEN_TTL_SEC = Number(process.env.PLAYBACK_TOKEN_TTL_SEC) || 300;
const usedPlaybackTokens = new Map();

function secret() {
  return process.env.PLAYBACK_TOKEN_SECRET || process.env.JWT_SECRET || 'change-playback-secret-in-production';
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function fromB64url(str) {
  return Buffer.from(str, 'base64url');
}

export function signPlaybackToken({ userId, videoId, ttlSec = TOKEN_TTL_SEC }) {
  const exp = Math.floor(Date.now() / 1000) + Math.max(60, ttlSec);
  const nonce = crypto.randomBytes(12).toString('base64url');
  const payload = `${userId}:${videoId}:${exp}:${nonce}`;
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  return {
    token: `${b64url(payload)}.${sig}`,
    expiresAt: exp * 1000,
  };
}

export function verifyPlaybackToken(token, userId, videoId) {
  if (!token || !userId || !videoId) return false;
  const parts = String(token).split('.');
  if (parts.length !== 2) return false;
  try {
    const payload = fromB64url(parts[0]).toString('utf8');
    const [uid, vid, expStr] = payload.split(':');
    if (uid !== userId || vid !== videoId) return false;
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
    const expected = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[1]));
  } catch {
    return false;
  }
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(`${secret()}:${String(token || '')}`).digest('hex');
}

function playbackTokenExpiry(token) {
  try {
    const [payloadPart] = String(token || '').split('.');
    const payload = fromB64url(payloadPart).toString('utf8');
    const [, , expStr] = payload.split(':');
    const exp = Number(expStr);
    return Number.isFinite(exp) ? exp : 0;
  } catch {
    return 0;
  }
}

function cleanupUsedPlaybackTokens(nowSec) {
  for (const [hash, exp] of usedPlaybackTokens.entries()) {
    if (!Number.isFinite(exp) || exp < nowSec) usedPlaybackTokens.delete(hash);
  }
}

async function consumePlaybackToken(token, userId, videoId) {
  if (!verifyPlaybackToken(token, userId, videoId)) return { ok: false, reason: 'invalid' };
  const exp = playbackTokenExpiry(token);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!exp || exp < nowSec) return { ok: false, reason: 'expired' };

  const hash = tokenHash(token);
  if (supabase) {
    const { error } = await supabase.from('playback_token_usage').insert({
      token_hash: hash,
      user_id: userId,
      video_id: videoId,
      expires_at: new Date(exp * 1000).toISOString(),
    });
    if (!error) return { ok: true };
    if (error.code === '23505') return { ok: false, reason: 'reused' };
    if (!isMissingDbFeature(error)) throw error;
  }

  cleanupUsedPlaybackTokens(nowSec);
  if (usedPlaybackTokens.has(hash)) return { ok: false, reason: 'reused' };
  usedPlaybackTokens.set(hash, exp);
  return { ok: true };
}

async function legacyPurchaseExists(uid, videoId) {
  if (supabase) {
    const { data, error } = await supabase
      .from('premium_video_purchases')
      .select('id')
      .eq('user_id', uid)
      .eq('video_id', videoId)
      .eq('access_status', 'active')
      .maybeSingle();
    if (!error && data?.id) return true;

    const tiktok = await supabase
      .from('video_purchases')
      .select('id')
      .eq('user_id', uid)
      .eq('video_id', videoId)
      .maybeSingle();
    if (!tiktok.error && tiktok.data?.id) return true;

    const pub = await supabase
      .from('public_video_purchases')
      .select('id')
      .eq('user_id', uid)
      .eq('public_video_id', videoId)
      .maybeSingle();
    if (!pub.error && pub.data?.id) return true;
  }

  const rtdb = getFirebaseRtdb();
  if (rtdb) {
    const snap = await rtdb.ref(`videoPurchases/${uid}/${videoId}`).once('value');
    if (snap.exists()) return true;
  }
  return false;
}

export async function userHasPremiumAccess(userId, videoId, creatorId = null) {
  if (!userId || !videoId) return false;
  if (creatorId && creatorId === userId) return true;

  if (supabase) {
    const { data, error } = await supabase
      .from('premium_video_purchases')
      .select('id, access_status, refund_status')
      .eq('user_id', userId)
      .eq('video_id', videoId)
      .maybeSingle();
    if (!error && data?.id) {
      return data.access_status === 'active' && data.refund_status === 'none';
    }
    if (error && !isMissingDbFeature(error)) throw error;
  }

  return legacyPurchaseExists(userId, videoId);
}

export async function assertPremiumPlaybackAccess({ userId, videoId, creatorId, playbackToken }) {
  if (!userId) {
    const err = new Error('Sign in required to watch premium content.');
    err.statusCode = 401;
    err.code = 'AUTH_REQUIRED';
    throw err;
  }

  if (playbackToken) {
    const consumed = await consumePlaybackToken(playbackToken, userId, videoId);
    if (!consumed.ok) {
      const err = new Error('Playback session expired. Please start playback again.');
      err.statusCode = 401;
      err.code = consumed.reason === 'reused' ? 'PLAYBACK_TOKEN_REUSED' : 'PLAYBACK_TOKEN_EXPIRED';
      throw err;
    }
  }

  const allowed = await userHasPremiumAccess(userId, videoId, creatorId);
  if (!allowed) {
    const err = new Error('Purchase required to watch this premium video.');
    err.statusCode = 403;
    err.code = 'PREMIUM_REQUIRED';
    throw err;
  }
  return true;
}
