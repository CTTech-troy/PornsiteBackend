import { supabase, isConfigured } from '../config/supabase.js';

// Creator management + wallet helpers

async function getCreator(userId) {
	if (!isConfigured()) throw new Error('Supabase not configured');
	const { data, error } = await supabase.from('creators').select('*').eq('user_id', userId).maybeSingle();
	if (error) throw error;
	return data;
}

async function upsertCreator(userId, profile) {
	if (!isConfigured()) throw new Error('Supabase not configured');
	const payload = { user_id: userId, ...profile };
	const { data, error } = await supabase.from('creators').upsert(payload, { onConflict: 'user_id' }).select().maybeSingle();
	if (error) throw error;
	return data;
}

async function getWallet(ownerId) {
	if (!isConfigured()) throw new Error('Supabase not configured');
	const { data, error } = await supabase.from('wallets').select('*').eq('owner_id', ownerId).maybeSingle();
	if (error) throw error;
	return data || { owner_id: ownerId, balance: 0 };
}

async function incrementWallet(ownerId, amount) {
	if (!isConfigured()) throw new Error('Supabase not configured');
	// Try RPC if exists
	try {
		const rpcName = 'increment_wallet_balance';
		// RPC signature: (p_owner_id text, p_amount numeric)
		const { data, error } = await supabase.rpc(rpcName, { p_owner_id: ownerId, p_amount: Number(amount) });
		if (error) throw error;
		return data;
	} catch (rpcErr) {
		// Fallback to upsert/update
		const { data: existing, error: exErr } = await supabase.from('wallets').select('*').eq('owner_id', ownerId).maybeSingle();
		if (exErr) throw exErr;
		if (existing) {
			const newBal = Number(existing.balance || 0) + Number(amount || 0);
			const { data, error } = await supabase.from('wallets').update({ balance: newBal, updated_at: new Date().toISOString() }).eq('owner_id', ownerId).select().maybeSingle();
			if (error) throw error;
			return data;
		}
		const { data, error } = await supabase.from('wallets').insert([{ owner_id: ownerId, balance: Number(amount || 0) }]).select().maybeSingle();
		if (error) throw error;
		return data;
	}
}

async function debitWallet(ownerId, amount) {
	if (!isConfigured()) throw new Error('Supabase not configured');
	const { data: w, error: wErr } = await supabase.from('wallets').select('*').eq('owner_id', ownerId).maybeSingle();
	if (wErr) throw wErr;
	const balance = Number(w?.balance || 0);
	const amt = Number(amount || 0);
	if (balance < amt) throw new Error('Insufficient wallet balance');
	const newBal = +(balance - amt).toFixed(2);
	const { data, error } = await supabase.from('wallets').update({ balance: newBal, updated_at: new Date().toISOString() }).eq('owner_id', ownerId).select().maybeSingle();
	if (error) throw error;
	return data;
}

// Compute total earnings for a creator by summing live_gifts for lives owned by host
async function computeEarningsForHost(hostId) {
	if (!isConfigured()) throw new Error('Supabase not configured');
	// fetch lives for host
	const { data: lives, error: livesErr } = await supabase.from('lives').select('id').eq('host_id', hostId);
	if (livesErr) throw livesErr;
	const liveIds = (lives || []).map(l => l.id).filter(Boolean);
	if (!liveIds.length) return { total: 0, companyShare: 0, hostShare: 0 };
	const { data: gifts, error: giftsErr } = await supabase.from('live_gifts').select('amount').in('live_id', liveIds);
	if (giftsErr) throw giftsErr;
	const total = (gifts || []).reduce((s, g) => s + Number(g.amount || 0), 0);
	const companyShare = +(total * 0.3).toFixed(2);
	const hostShare = +(total * 0.7).toFixed(2);
	return { total, companyShare, hostShare };
}

export {
	getCreator,
	upsertCreator,
	getWallet,
	incrementWallet,
	debitWallet,
	computeEarningsForHost
};

