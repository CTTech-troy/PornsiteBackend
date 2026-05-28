import {
  adjustCoins,
  createCoinPackage,
  deleteCoinPackage,
  getCoinAnalytics,
  getCoinPackages,
  getGiftCatalog,
  getGiftCatalogAnalytics,
  getGiftCatalogAdmin,
  createGiftCatalogItem,
  updateGiftCatalogItem,
  toggleGiftCatalogItem,
  deleteGiftCatalogItem,
  getCoinWallet,
  listCoinTransactions,
  sendCreatorGift,
  setCoinBalance,
  spendCoins,
  toggleCoinPackage,
  transferCoins,
  updateCoinPackage,
  uploadGiftImageAsset,
} from '../services/coinWallet.service.js';
import { createSecurePaymentSession } from '../services/securePayments.service.js';

export async function getPublicCoinPackages(_req, res) {
  try {
    const packages = await getCoinPackages();
    return res.json({ success: true, ok: true, data: packages });
  } catch (error) {
    return res.status(500).json({ success: false, ok: false, error: error.message });
  }
}

export async function getPublicGiftCatalog(_req, res) {
  try {
    const gifts = await getGiftCatalog();
    return res.json({ success: true, ok: true, data: gifts });
  } catch (error) {
    return res.json({ success: true, ok: true, data: [], warning: error.message });
  }
}

export async function getMyCoinWallet(req, res) {
  try {
    const wallet = await getCoinWallet(req.uid);
    return res.json({ success: true, ok: true, wallet, balance: wallet.balance });
  } catch (error) {
    return res.status(500).json({ success: false, ok: false, error: error.message });
  }
}

export async function getMyCoinTransactions(req, res) {
  try {
    const data = await listCoinTransactions(req.uid, req.query);
    return res.json({ success: true, ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ success: false, ok: false, error: error.message });
  }
}

export async function buyCoinPackage(req, res) {
  try {
    const checkout = await createSecurePaymentSession({
      userId: req.uid,
      productType: 'coins',
      productId: req.body?.packageId,
      countryCode: req.body?.countryCode || 'US',
      billingCountry: req.body?.billingCountry || null,
      customerEmail: req.body?.customerEmail || '',
      customerName: req.body?.customerName || 'Member',
      customerPhone: req.body?.customerPhone || '',
      req,
    });
    return res.json({ success: true, ok: true, ...checkout });
  } catch (error) {
    const status = /unreachable|timed out/i.test(error.message) ? 503 : 500;
    return res.status(status).json({ success: false, ok: false, error: error.message });
  }
}

export async function spendMyCoins(req, res) {
  try {
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, ok: false, error: 'amount must be positive' });
    }
    const result = await spendCoins({
      userId: req.uid,
      amount,
      type: 'spend',
      reference: req.body?.reference || null,
      metadata: req.body?.metadata || {},
      sourceType: req.body?.sourceType || 'api_spend',
      sourceId: req.body?.sourceId || null,
    });
    return res.json({ success: true, ok: true, newBalance: result.balance, transactionId: result.transactionId });
  } catch (error) {
    const status = error.code === 'INSUFFICIENT_TOKENS' ? 402 : 500;
    return res.status(status).json({ success: false, ok: false, error: error.message, code: error.code });
  }
}

export async function transferMyCoins(req, res) {
  try {
    const { recipientId, amount } = req.body || {};
    if (!recipientId) return res.status(400).json({ success: false, ok: false, error: 'recipientId is required' });
    const result = await transferCoins({
      senderId: req.uid,
      recipientId,
      amount: Number(amount),
      reference: req.body?.reference || null,
      metadata: req.body?.metadata || {},
      sourceType: 'transfer',
    });
    return res.json({ success: true, ok: true, ...result });
  } catch (error) {
    const status = error.code === 'INSUFFICIENT_TOKENS' ? 402 : 500;
    return res.status(status).json({ success: false, ok: false, error: error.message, code: error.code });
  }
}

export async function giftCreator(req, res) {
  try {
    const { creatorId, streamId, giftId, gift, senderName } = req.body || {};
    const result = await sendCreatorGift({
      userId: req.uid,
      senderName,
      creatorId,
      streamId,
      giftId: giftId || gift?.id,
      gift,
    });
    emitGiftRealtime(req, {
      streamId,
      senderId: req.uid,
      senderName,
      result,
    });
    return res.json({
      success: true,
      ok: true,
      newBalance: result.newBalance,
      giftId: result.giftId,
      liveGiftId: result.liveGiftId,
      totalGiftsAmount: result.totalGiftsAmount,
      creatorAmount: result.creatorAmount,
      platformAmount: result.platformAmount,
      gift: result.gift,
    });
  } catch (error) {
    const status = error.code === 'INSUFFICIENT_TOKENS'
      ? 402
      : error.code === 'GIFT_NOT_FOUND'
        ? 400
        : error.code === 'GIFT_SYSTEM_UNAVAILABLE'
          ? 503
          : 500;
    return res.status(status).json({ success: false, ok: false, error: error.message, code: error.code });
  }
}

export async function getAdminCoinPackages(_req, res) {
  try {
    const packages = await getCoinPackages({ includeInactive: true });
    const analytics = await getCoinAnalytics();
    return res.json({ success: true, data: packages, stats: analytics });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function createAdminCoinPackage(req, res) {
  try {
    const data = await createCoinPackage(req.body || {});
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function updateAdminCoinPackage(req, res) {
  try {
    const data = await updateCoinPackage(req.params.id, req.body || {});
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function toggleAdminCoinPackage(req, res) {
  try {
    const data = await toggleCoinPackage(req.params.id, req.body?.isActive);
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function deleteAdminCoinPackage(req, res) {
  try {
    await deleteCoinPackage(req.params.id);
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function getAdminCoinWallet(req, res) {
  try {
    const wallet = await getCoinWallet(req.params.userId);
    const tx = await listCoinTransactions(req.params.userId, req.query);
    return res.json({ success: true, wallet, ...tx });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function adjustAdminCoinWallet(req, res) {
  try {
    const { amount, targetBalance, reason } = req.body || {};
    const result = targetBalance != null
      ? await setCoinBalance({ userId: req.params.userId, targetBalance: Number(targetBalance), actorId: req.admin?.id, reason })
      : await adjustCoins({ userId: req.params.userId, delta: Number(amount), actorId: req.admin?.id, reason });
    return res.json({ success: true, balance: result.balance, transactionId: result.transactionId });
  } catch (error) {
    const status = error.code === 'INSUFFICIENT_TOKENS' ? 400 : 500;
    return res.status(status).json({ success: false, error: error.message });
  }
}

export async function getAdminCoinTransactions(req, res) {
  try {
    const userId = req.query.userId || req.params.userId;
    if (!userId) return res.status(400).json({ success: false, error: 'userId is required' });
    const data = await listCoinTransactions(userId, req.query);
    return res.json({ success: true, ...data });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function getAdminGiftCatalog(_req, res) {
  try {
    const gifts = await getGiftCatalogAdmin({ includeInactive: true });
    const stats = await getGiftCatalogAnalytics(gifts);
    return res.json({
      success: true,
      data: gifts,
      stats,
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function createAdminGiftCatalogItem(req, res) {
  try {
    const data = await createGiftCatalogItem(req.body || {});
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function updateAdminGiftCatalogItem(req, res) {
  try {
    const data = await updateGiftCatalogItem(req.params.id, req.body || {});
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function toggleAdminGiftCatalogItem(req, res) {
  try {
    const data = await toggleGiftCatalogItem(req.params.id, req.body?.isActive);
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function deleteAdminGiftCatalogItem(req, res) {
  try {
    await deleteGiftCatalogItem(req.params.id);
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function uploadAdminGiftImage(req, res) {
  try {
    const data = await uploadGiftImageAsset(req.file);
    return res.status(201).json({ success: true, ...data });
  } catch (error) {
    const status = error.code === 'INVALID_GIFT_IMAGE' ? 400 : 500;
    return res.status(status).json({ success: false, error: error.message, message: error.message });
  }
}

export async function getAdminCoinAnalytics(_req, res) {
  try {
    const analytics = await getCoinAnalytics();
    return res.json({ success: true, analytics });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

function emitGiftRealtime(req, { streamId, senderId, senderName, result }) {
  const io = req.app?.get?.('io');
  if (!io || !streamId || !result?.gift) return;
  const gift = result.gift;
  const payload = {
    id: result.liveGiftId || result.giftId || `${Date.now()}`,
    liveId: result.liveGiftId ? streamId : undefined,
    roomId: result.liveGiftId ? undefined : streamId,
    senderId,
    senderName: senderName || 'Viewer',
    giftId: gift.id,
    giftType: gift.id,
    giftName: gift.name,
    name: gift.name,
    emoji: gift.emoji,
    imageUrl: gift.imageUrl,
    animationType: gift.animationType,
    category: gift.category,
    rarity: gift.rarity,
    amount: Number(gift.coinCost || gift.price || 0),
    totalGiftsAmount: result.totalGiftsAmount,
    createdAt: new Date().toISOString(),
  };
  if (result.liveGiftId) io.to(streamId).emit('new-gift', payload);
  else io.to(streamId).emit('chat:gift', payload);
}
