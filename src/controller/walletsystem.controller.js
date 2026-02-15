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

async function fundWallet(ownerId, amount, meta = {}) {
  if (!isConfigured()) throw new Error('Supabase not configured');
  await createOrEnsureWallet(ownerId);
  const { data: w } = await supabase.from('wallets').select('*').eq('owner_id', ownerId).maybeSingle();
  const newBal = +(Number(w?.balance || 0) + Number(amount || 0)).toFixed(2);
  const { data, error } = await supabase.from('wallets').update({ balance: newBal, updated_at: new Date().toISOString() }).eq('owner_id', ownerId).select().maybeSingle();
  if (error) throw error;
  await createTransaction(ownerId, 'credit', Number(amount), newBal, meta);
  return data;
}

async function debitWallet(ownerId, amount, meta = {}) {
  if (!isConfigured()) throw new Error('Supabase not configured');
  const { data: w, error: wErr } = await supabase.from('wallets').select('*').eq('owner_id', ownerId).maybeSingle();
  if (wErr) throw wErr;
  const balance = Number(w?.balance || 0);
  const amt = Number(amount || 0);
  if (balance < amt) throw new Error('Insufficient balance');
  const newBal = +(balance - amt).toFixed(2);
  const { data, error } = await supabase.from('wallets').update({ balance: newBal, updated_at: new Date().toISOString() }).eq('owner_id', ownerId).select().maybeSingle();
  if (error) throw error;
  await createTransaction(ownerId, 'debit', amt, newBal, meta);
  return data;
}

/**
 * Charge the sender for a gift and distribute payout to host and company.
 * This will:
 * - debit sender wallet
 * - persist gift via live controller (via gift controller)
 * - credit host wallet with 70%
 * - credit company wallet with 30%
 */
async function processGiftPayment({ liveId, senderId, giftType, quantity = 1 }) {
  if (!isConfigured()) throw new Error('Supabase not configured');
  const gift = giftCtrl.getGift(giftType);
  if (!gift) throw new Error('Invalid gift type');
  const qty = Number(quantity) || 1;
  const totalAmount = +(gift.price * qty).toFixed(2);

  // Debit sender
  await debitWallet(senderId, totalAmount, { reason: 'gift_purchase', giftType, quantity: qty, liveId });

  // Persist gift to live_gifts and update live totals
  // giftCtrl.processGift will call liveCtrl.sendGift internally
  const result = await giftCtrl.processGift({ liveId, senderId, giftType, quantity: qty });

  // Distribute payout immediately: host receives 70%, company 30%
  const { split } = result;
  const hostShare = Number(split.hostShare || 0);
  const companyShare = Number(split.companyShare || 0);

  // Need to determine hostId for the live
  const { data: live, error: liveErr } = await supabase.from('lives').select('host_id').eq('id', liveId).maybeSingle();
  if (liveErr) throw liveErr;
  const hostId = live?.host_id;

  if (hostId) {
    await fundWallet(hostId, hostShare, { reason: 'gift_host_share', liveId, giftType, quantity: qty, from: senderId });
  }
  // credit company wallet
  await fundWallet(COMPANY_WALLET_OWNER, companyShare, { reason: 'gift_company_share', liveId, giftType, quantity: qty, from: senderId });

  return { result, hostShare, companyShare, totalAmount };
}

/**
 * Helper to withdraw from a creator wallet to external payout (simulated).
 */
async function withdrawPayout(ownerId, amount, meta = {}) {
  if (!isConfigured()) throw new Error('Supabase not configured');
  // debit wallet and record a payout transaction
  const debited = await debitWallet(ownerId, amount, { ...meta, reason: 'withdraw' });
  // In production, integrate with payment processor to send funds externally.
  // Here we simply record a 'payout' transaction entry
  const { data: w } = await supabase.from('wallets').select('*').eq('owner_id', ownerId).maybeSingle();
  await createTransaction(ownerId, 'payout', Number(amount), Number(w?.balance || 0), meta);
  return { success: true, balance: Number(w?.balance || 0) };
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
