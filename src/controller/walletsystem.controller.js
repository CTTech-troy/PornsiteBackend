import { supabase, isConfigured } from '../config/supabase.js';
import * as giftCtrl from './gift.controller.js';

const COMPANY_WALLET_OWNER = process.env.COMPANY_WALLET_OWNER || 'company';

async function getWallet(ownerId) {
  if (!isConfigured()) throw new Error('Supabase not configured');
  const { data, error } = await supabase.from('wallets').select('*').eq('owner_id', ownerId).maybeSingle();
  if (error) throw error;
  return data || { owner_id: ownerId, balance: 0 };
}

async function createOrEnsureWallet(ownerId) {
  if (!isConfigured()) throw new Error('Supabase not configured');
  const { data, error } = await supabase.from('wallets').upsert({ owner_id: ownerId }, { onConflict: 'owner_id' }).select().maybeSingle();
  if (error) throw error;
  return data;
}

async function createTransaction(ownerId, type, amount, balanceAfter, meta = {}) {
  if (!isConfigured()) throw new Error('Supabase not configured');
  const { data, error } = await supabase.from('transactions').insert([{ owner_id: ownerId, type, amount, balance_after: balanceAfter, meta }]).select().maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Atomically credit a wallet using the Postgres RPC function.
 * The RPC uses SELECT ... FOR UPDATE to prevent race conditions.
 */
async function fundWallet(ownerId, amount, meta = {}) {
  if (!isConfigured()) throw new Error('Supabase not configured');
  const amt = +Number(amount || 0).toFixed(2);
  if (amt <= 0) throw new Error('Amount must be positive');

  const { data: newBal, error } = await supabase.rpc('credit_wallet', {
    p_owner_id: ownerId,
    p_amount: amt,
  });
  if (error) throw error;

  const balAfter = Number(newBal);
  await createTransaction(ownerId, 'credit', amt, balAfter, meta);

  return { owner_id: ownerId, balance: balAfter };
}

/**
 * Atomically debit a wallet using the Postgres RPC function.
 * The RPC checks balance and deducts in a single locked transaction,
 * preventing double-spend / race conditions.
 */
async function debitWallet(ownerId, amount, meta = {}) {
  if (!isConfigured()) throw new Error('Supabase not configured');
  const amt = +Number(amount || 0).toFixed(2);
  if (amt <= 0) throw new Error('Amount must be positive');

  const { data: newBal, error } = await supabase.rpc('debit_wallet', {
    p_owner_id: ownerId,
    p_amount: amt,
  });

  if (error) {
    // The Postgres function raises 'Insufficient balance' — surface it cleanly
    if (error.message && /insufficient balance/i.test(error.message)) {
      throw new Error('Insufficient balance');
    }
    if (error.message && /wallet not found/i.test(error.message)) {
      throw new Error('Wallet not found');
    }
    throw error;
  }

  const balAfter = Number(newBal);
  await createTransaction(ownerId, 'debit', amt, balAfter, meta);

  return { owner_id: ownerId, balance: balAfter };
}

/**
 * Charge the sender for a gift and distribute payout to host and company.
 * This will:
 * - debit sender wallet (atomic)
 * - persist gift via live controller (via gift controller)
 * - credit host wallet with 70% (atomic)
 * - credit company wallet with 30% (atomic)
 */
async function processGiftPayment({ liveId, senderId, giftType, quantity = 1 }) {
  if (!isConfigured()) throw new Error('Supabase not configured');
  const gift = giftCtrl.getGift(giftType);
  if (!gift) throw new Error('Invalid gift type');
  const qty = Number(quantity) || 1;
  const totalAmount = +(gift.price * qty).toFixed(2);

  // Atomic debit — will throw if insufficient balance
  await debitWallet(senderId, totalAmount, { reason: 'gift_purchase', giftType, quantity: qty, liveId });

  // Persist gift to live_gifts and update live totals
  const result = await giftCtrl.processGift({ liveId, senderId, giftType, quantity: qty });

  // Distribute payout immediately: host receives 70%, company 30%
  const { split } = result;
  const hostShare = +Number(split.hostShare || 0).toFixed(2);
  const companyShare = +Number(split.companyShare || 0).toFixed(2);

  // Determine hostId for the live
  const { data: live, error: liveErr } = await supabase.from('lives').select('host_id').eq('id', liveId).maybeSingle();
  if (liveErr) throw liveErr;
  const hostId = live?.host_id;

  if (hostId && hostShare > 0) {
    await fundWallet(hostId, hostShare, { reason: 'gift_host_share', liveId, giftType, quantity: qty, from: senderId });
  }
  // credit company wallet
  if (companyShare > 0) {
    await fundWallet(COMPANY_WALLET_OWNER, companyShare, { reason: 'gift_company_share', liveId, giftType, quantity: qty, from: senderId });
  }

  return { result, hostShare, companyShare, totalAmount };
}

/**
 * Helper to withdraw from a creator wallet to external payout (simulated).
 */
async function withdrawPayout(ownerId, amount, meta = {}) {
  if (!isConfigured()) throw new Error('Supabase not configured');
  const amt = +Number(amount || 0).toFixed(2);
  if (amt <= 0) throw new Error('Amount must be positive');

  // Atomic debit
  const debited = await debitWallet(ownerId, amt, { ...meta, reason: 'withdraw' });

  // In production, integrate with payment processor to send funds externally.
  // Here we record a 'payout' transaction entry
  await createTransaction(ownerId, 'payout', amt, debited.balance, meta);
  return { success: true, balance: debited.balance };
}

export {
  getWallet,
  createOrEnsureWallet,
  fundWallet,
  debitWallet,
  processGiftPayment,
  withdrawPayout,
  createTransaction
};
