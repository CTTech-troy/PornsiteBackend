import * as liveCtrl from './live.controller.js';
import { getNumberSetting } from '../services/platformSettings.service.js';
import {
  getActiveGiftById,
  getGiftCatalog,
} from '../services/coinWallet.service.js';

async function getCatalog() {
  return getGiftCatalog();
}

async function getGift(type) {
  return getActiveGiftById(type);
}

async function processGift({ liveId, senderId, giftType, quantity = 1 }) {
  const gift = await getActiveGiftById(giftType);
  const qty = Math.max(1, Math.min(25, Number(quantity) || 1));
  const amount = +(Number(gift.coinCost || gift.price || 0) * qty).toFixed(2);
  if (amount <= 0) throw new Error('Invalid gift amount');

  const record = await liveCtrl.sendGift(liveId, senderId, gift.id, amount, {
    giftName: gift.name,
    giftEmoji: gift.emoji,
    senderName: null,
    imageUrl: gift.imageUrl,
    animationType: gift.animationType,
    category: gift.category,
    rarity: gift.rarity,
  });

  const creatorPercent = await getNumberSetting('live_gift_creator_percent', 70);
  const safeCreatorPercent = Math.min(100, Math.max(0, creatorPercent));
  const hostShare = +(amount * (safeCreatorPercent / 100)).toFixed(2);
  const companyShare = +(amount - hostShare).toFixed(2);

  return {
    gift: {
      ...gift,
      quantity: qty,
      amount,
    },
    record,
    split: { companyShare, hostShare },
  };
}

export { getCatalog, getGift, processGift };
