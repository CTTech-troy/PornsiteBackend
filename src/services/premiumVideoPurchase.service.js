import { randomUUID } from 'crypto';
import { supabase } from '../config/supabase.js';
import { getNumberSetting } from './platformSettings.service.js';
import {
  getCommissionRates,
  money,
  recordCreatorEarning,
  splitGrossAmount,
  isMissingDbFeature,
} from './revenueCalculation.service.js';
import { sendPremiumVideoPurchaseEmails } from './emailService.js';
import { userHasPremiumAccess } from './playbackAccess.service.js';
import { creditCoins, spendCoins } from './coinWallet.service.js';
import { writeFinanceActivityEvent } from './financePayoutEvents.service.js';
import { writePlatformActivityEvent } from './platformActivity.service.js';

function isMissingPremiumPurchaseRpc(error) {
  const message = String(error?.message || '');
  return isMissingDbFeature(error)
    || error?.code === '42883'
    || error?.code === 'PGRST202'
    || /secure_purchase_premium_video|function .* does not exist|could not find/i.test(message);
}

function deviceInfoFromRequest(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return {
    ip: forwarded || req?.ip || null,
    userAgent: String(req?.headers?.['user-agent'] || '').slice(0, 500),
  };
}

async function logPurchaseAudit(event) {
  if (!supabase) return;
  const { error } = await supabase.from('premium_purchase_audit_log').insert({
    purchase_id: event.purchaseId || null,
    event_type: event.type,
    user_id: event.userId || null,
    creator_id: event.creatorId || null,
    video_id: event.videoId || null,
    payload: event.payload || {},
  });
  if (error && !isMissingDbFeature(error)) {
    console.warn('[premiumPurchase] audit log failed:', error.message);
  }
}

async function notifyCreatorInApp({ creatorId, buyerUsername, videoTitle, creatorEarningsUsd, purchaseId }) {
  if (!supabase || !creatorId) return;
  const earnings = money(creatorEarningsUsd);
  const title = 'Premium video sold';
  const message = `User ${buyerUsername || 'A fan'} purchased your premium video "${videoTitle || 'Untitled'}". You earned $${earnings.toFixed(2)}.`;
  const { error } = await supabase.from('creator_notifications').insert({
    user_id: creatorId,
    type: 'premium_purchase',
    title,
    message,
    data: { purchaseId, videoTitle, buyerUsername, creatorEarningsUsd: earnings },
    read_at: null,
  });
  if (error && !isMissingDbFeature(error)) {
    console.warn('[premiumPurchase] creator notification failed:', error.message);
  }
}

async function resolveUserProfile(userId) {
  if (!supabase || !userId) return { name: 'A user', email: null };
  const { data } = await supabase.from('users').select('username, display_name, email').eq('id', userId).maybeSingle();
  return {
    name: data?.display_name || data?.username || data?.email?.split('@')[0] || 'A user',
    email: data?.email || null,
  };
}

async function resolveCreatorProfile(creatorId) {
  if (!supabase || !creatorId) return { name: 'Creator', email: null };
  const { data } = await supabase.from('users').select('email, display_name, username').eq('id', creatorId).maybeSingle();
  return {
    name: data?.display_name || data?.username || 'Creator',
    email: data?.email || null,
  };
}

export async function tokensToUsd(tokenAmount) {
  const rate = await getNumberSetting('coin_to_usd_rate', 0.01);
  return money(Number(tokenAmount) * rate);
}

export async function findPremiumPurchase(userId, videoId) {
  if (!supabase || !userId || !videoId) return null;
  const { data, error } = await supabase
    .from('premium_video_purchases')
    .select('*')
    .eq('user_id', userId)
    .eq('video_id', videoId)
    .maybeSingle();
  if (error && isMissingDbFeature(error)) return null;
  if (error) throw error;
  return data;
}

export async function completePremiumVideoPurchase({
  userId,
  video,
  tokenPrice,
  paymentReference,
  req = null,
  debitWallet = false,
}) {
  const videoId = video.publicVideoId;
  const creatorId = video.userId || null;
  const existing = await findPremiumPurchase(userId, videoId);
  if (existing?.access_status === 'active' && existing.refund_status === 'none') {
    return { duplicate: true, purchase: existing };
  }

  const purchaseAmountUsd = await tokensToUsd(tokenPrice);
  const rates = await getCommissionRates({ creatorId, source: 'video_purchase' });
  const split = splitGrossAmount(purchaseAmountUsd, rates.platformPercent);
  const idempotencyKey = `pvp:${userId}:${videoId}`;
  const purchaseId = randomUUID();
  let newBalance = null;
  let walletTransactionId = null;
  let earningAlreadyRecorded = false;

  let purchaseRow = null;
  if (debitWallet && supabase) {
    const rpc = await supabase.rpc('secure_purchase_premium_video', {
      p_user_id: userId,
      p_creator_id: creatorId,
      p_video_id: videoId,
      p_tiktok_video_id: video.tiktokVideoId || null,
      p_video_title: video.title || '',
      p_token_price: tokenPrice,
      p_purchase_amount_usd: purchaseAmountUsd,
      p_creator_revenue_usd: split.creatorEarningsUsd,
      p_platform_revenue_usd: split.platformFeeUsd,
      p_payment_reference: paymentReference || idempotencyKey,
      p_device_info: req ? deviceInfoFromRequest(req) : {},
      p_session_id: req?.headers?.['x-session-id'] || null,
      p_metadata: { videoSource: video.source || 'public' },
    });

    if (!rpc.error) {
      const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
      if (row?.duplicate === true) {
        const dup = await findPremiumPurchase(userId, videoId);
        return { duplicate: true, purchase: dup, newBalance: Number(row?.new_balance || 0) };
      }
      newBalance = Number(row?.new_balance || 0);
      walletTransactionId = row?.wallet_transaction_id || null;
      purchaseRow = {
        id: row?.purchase_id || purchaseId,
        user_id: userId,
        creator_id: creatorId,
        video_id: videoId,
        video_title: video.title || '',
        purchase_amount_tokens: tokenPrice,
        purchase_amount_usd: purchaseAmountUsd,
        creator_revenue_usd: split.creatorEarningsUsd,
        platform_revenue_usd: split.platformFeeUsd,
        payment_reference: paymentReference || idempotencyKey,
        payment_provider: 'coin_wallet',
      };
      earningAlreadyRecorded = true;
    } else if (!isMissingPremiumPurchaseRpc(rpc.error)) {
      throw rpc.error;
    }
  }

  let fallbackDebit = null;
  if (!purchaseRow && debitWallet) {
    fallbackDebit = await spendCoins({
      userId,
      amount: tokenPrice,
      type: 'spend',
      reference: paymentReference || idempotencyKey,
      metadata: { reason: 'premium_video_purchase', videoId, creatorId },
      idempotencyKey: `premium_video_purchase:${userId}:${videoId}`,
      relatedUserId: creatorId,
      sourceType: 'premium_video',
      sourceId: videoId,
    });
    newBalance = Number(fallbackDebit.balance || 0);
    walletTransactionId = fallbackDebit.transactionId || null;
  }

  if (!purchaseRow && supabase) {
    const { data, error } = await supabase
      .from('premium_video_purchases')
      .insert({
        id: purchaseId,
        user_id: userId,
        creator_id: creatorId,
        video_id: videoId,
        tiktok_video_id: video.tiktokVideoId || null,
        video_title: video.title || '',
        purchase_amount_tokens: tokenPrice,
        purchase_amount_usd: purchaseAmountUsd,
        creator_revenue_usd: split.creatorEarningsUsd,
        platform_revenue_usd: split.platformFeeUsd,
        currency: 'USD',
        payment_reference: paymentReference || idempotencyKey,
        payment_provider: 'coin_wallet',
        access_status: 'active',
        refund_status: 'none',
        device_info: req ? deviceInfoFromRequest(req) : {},
        session_id: req?.headers?.['x-session-id'] || null,
        idempotency_key: idempotencyKey,
        metadata: { videoSource: video.source || 'public', walletTransactionId },
      })
      .select()
      .maybeSingle();

    if (error) {
      if (error.code === '23505') {
        if (fallbackDebit) {
          await creditCoins({
            userId,
            amount: tokenPrice,
            type: 'refund',
            reference: `${paymentReference || idempotencyKey}:duplicate_refund`,
            idempotencyKey: `premium_video_duplicate_refund:${userId}:${videoId}`,
            sourceType: 'premium_video_refund',
            sourceId: videoId,
            metadata: { reason: 'duplicate_after_wallet_debit', videoId },
          }).catch(() => null);
        }
        const dup = await findPremiumPurchase(userId, videoId);
        return { duplicate: true, purchase: dup };
      }
      if (!isMissingDbFeature(error)) {
        if (fallbackDebit) {
          await creditCoins({
            userId,
            amount: tokenPrice,
            type: 'refund',
            reference: `${paymentReference || idempotencyKey}:failed_refund`,
            idempotencyKey: `premium_video_failed_refund:${userId}:${videoId}:${purchaseId}`,
            sourceType: 'premium_video_refund',
            sourceId: videoId,
            metadata: { reason: 'purchase_record_failed', videoId, error: error.message },
          }).catch(() => null);
        }
        throw error;
      }
    } else {
      purchaseRow = data;
    }
  }

  const earningRef = `premium_purchase:${purchaseId}`;
  if (!earningAlreadyRecorded && creatorId && split.creatorEarningsUsd > 0) {
    await recordCreatorEarning({
      creatorId,
      grossUsd: purchaseAmountUsd,
      source: 'video_purchase',
      referenceId: earningRef,
      metadata: {
        videoId,
        purchaseId,
        buyerId: userId,
        platformFeeUsd: split.platformFeeUsd,
      },
    });
  }

  const buyerProfile = await resolveUserProfile(userId);
  const buyerName = buyerProfile.name;
  await notifyCreatorInApp({
    creatorId,
    buyerUsername: buyerName,
    videoTitle: video.title,
    creatorEarningsUsd: split.creatorEarningsUsd,
    purchaseId,
  });

  const creatorProfile = await resolveCreatorProfile(creatorId);
  await sendPremiumVideoPurchaseEmails({
    buyerEmail: buyerProfile.email,
    buyerName,
    creatorEmail: creatorProfile.email,
    creatorName: creatorProfile.name,
    videoTitle: video.title || 'Premium video',
    purchaseAmountUsd,
    creatorEarningsUsd: split.creatorEarningsUsd,
    platformEarningsUsd: split.platformFeeUsd,
    purchasedAt: new Date().toISOString(),
    transactionId: paymentReference || idempotencyKey,
  }).catch((err) => {
    console.warn('[premiumPurchase] email notify failed:', err?.message || err);
  });

  await logPurchaseAudit({
    type: 'purchase_completed',
    purchaseId,
    userId,
    creatorId,
    videoId,
    payload: { tokenPrice, purchaseAmountUsd, split },
  });

  await writeFinanceActivityEvent({
    eventType: 'premium_video_purchased',
    userId,
    creatorId,
    productType: 'premium_video',
    productId: videoId,
    amountUsd: purchaseAmountUsd,
    amountTokens: tokenPrice,
    provider: 'coin_wallet',
    reference: paymentReference || idempotencyKey,
    status: 'completed',
    metadata: {
      purchaseId: purchaseRow?.id || purchaseId,
      videoTitle: video.title || '',
      creatorRevenueUsd: split.creatorEarningsUsd,
      platformRevenueUsd: split.platformFeeUsd,
      walletTransactionId,
    },
  }).catch(() => null);

  await writePlatformActivityEvent({
    eventType: 'premium_video_purchased',
    title: 'Premium video purchased',
    message: `${buyer.name} purchased "${video.title || 'video'}"`,
    actorId: userId,
    targetType: 'video',
    targetId: videoId,
    payload: { purchaseId, creatorEarningsUsd: split.creatorEarningsUsd },
  }).catch(() => null);

  return {
    duplicate: false,
    purchase: purchaseRow || {
      id: purchaseId,
      user_id: userId,
      creator_id: creatorId,
      video_id: videoId,
      purchase_amount_usd: purchaseAmountUsd,
      creator_revenue_usd: split.creatorEarningsUsd,
      platform_revenue_usd: split.platformFeeUsd,
    },
    split,
    purchaseAmountUsd,
    newBalance,
    walletTransactionId,
  };
}

export async function listUserPurchasedVideos(userId, { page = 1, limit = 20, search = '' } = {}) {
  if (!supabase) return { data: [], meta: { page, limit, total: 0, hasMore: false } };
  const p = Math.max(1, page);
  const l = Math.min(50, Math.max(1, limit));
  const from = (p - 1) * l;
  const to = from + l - 1;

  let query = supabase
    .from('premium_video_purchases')
    .select('*', { count: 'exact' })
    .eq('user_id', userId)
    .eq('access_status', 'active')
    .order('purchased_at', { ascending: false });

  if (search.trim()) {
    query = query.ilike('video_title', `%${search.trim()}%`);
  }

  const { data, error, count } = await query.range(from, to);
  if (error && isMissingDbFeature(error)) {
    return { data: [], meta: { page: p, limit: l, total: 0, hasMore: false } };
  }
  if (error) throw error;

  const rows = data || [];
  const videoIds = rows.map((r) => r.video_id);
  let progressMap = new Map();
  if (videoIds.length) {
    const prog = await supabase
      .from('premium_video_watch_progress')
      .select('video_id, progress_seconds, duration_seconds')
      .eq('user_id', userId)
      .in('video_id', videoIds);
    if (!prog.error) {
      (prog.data || []).forEach((row) => progressMap.set(row.video_id, row));
    }
  }

  const items = rows.map((row) => {
    const prog = progressMap.get(row.video_id);
    return {
      id: row.id,
      videoId: row.video_id,
      title: row.video_title || 'Premium video',
      creatorId: row.creator_id,
      purchasedAt: row.purchased_at,
      amountUsd: money(row.purchase_amount_usd),
      amountTokens: money(row.purchase_amount_tokens),
      receiptNumber: row.payment_reference || row.id,
      progressSeconds: Number(prog?.progress_seconds || 0),
      durationSeconds: Number(prog?.duration_seconds || 0),
    };
  });

  const total = count ?? items.length;
  return {
    data: items,
    meta: { page: p, limit: l, total, hasMore: from + items.length < total },
  };
}

export async function saveWatchProgress(userId, videoId, progressSeconds, durationSeconds) {
  if (!supabase || !userId || !videoId) return null;
  const owned = await userHasPremiumAccess(userId, videoId);
  if (!owned) return null;

  const row = {
    user_id: userId,
    video_id: videoId,
    progress_seconds: Math.max(0, Number(progressSeconds) || 0),
    duration_seconds: durationSeconds != null ? Math.max(0, Number(durationSeconds) || 0) : null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('premium_video_watch_progress')
    .upsert(row, { onConflict: 'user_id,video_id' })
    .select()
    .maybeSingle();
  if (error && !isMissingDbFeature(error)) throw error;
  return data;
}

export async function getPurchaseReceipt(userId, purchaseId) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('premium_video_purchases')
    .select('*')
    .eq('id', purchaseId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}
