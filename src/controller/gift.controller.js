import * as liveCtrl from './live.controller.js';
import { getNumberSetting } from '../services/platformSettings.service.js';

// Simple in-memory gift catalog. In production this would live in DB.
const GIFT_CATALOG = [
  { type: 'rose', name: 'Rose', price: 5.00 },
  { type: 'diamond', name: 'Diamond', price: 50.00 },
  { type: 'crown', name: 'Crown', price: 150.00 },
  { type: 'star', name: 'Star', price: 20.00 }

  // more if possible 
];

function getCatalog() {
  return GIFT_CATALOG;
}

function getGift(type) {
  return GIFT_CATALOG.find(g => g.type === type) || null;
}

/**
 * Process sending a gift: validates gift type, calculates amount for quantity,
 * persists via live controller, and returns payout split.
 * @param {Object} params
 * @param {string} params.liveId
 * @param {string} params.senderId
 * @param {string} params.giftType
 * @param {number} [params.quantity=1]
 */
async function processGift({ liveId, senderId, giftType, quantity = 1 }) {
  const gift = getGift(giftType);
  if (!gift) throw new Error('Unknown gift type');
  const qty = Number(quantity) || 1;
  const amount = +(gift.price * qty).toFixed(2);

  // persist gift record using live controller helper
  const record = await liveCtrl.sendGift(liveId, senderId, giftType, amount);

  // compute payout split from global platform settings
  const creatorPercent = await getNumberSetting('live_gift_creator_percent', 70);
  const safeCreatorPercent = Math.min(100, Math.max(0, creatorPercent));
  const hostShare = +(amount * (safeCreatorPercent / 100)).toFixed(2);
  const companyShare = +(amount - hostShare).toFixed(2);

  return {
    gift: {
      ...gift,
      quantity: qty,
      amount
    },
    record,
    split: { companyShare, hostShare }
  };
}

export { getCatalog, getGift, processGift };
