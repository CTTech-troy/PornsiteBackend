import { supabase, isConfigured } from '../config/supabase.js';
import { getFirebaseRtdb } from '../config/firebase.js';

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

// Fetch all platform creators filtered by type ('channel' | 'pstar').
async function getCreatorsByType(type, limit = 100) {
	if (!isConfigured()) throw new Error('Supabase not configured');
	const safeType = type === 'channel' ? 'channel' : 'pstar';
	const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
	const { data, error } = await supabase
		.from('creators')
		.select('user_id, display_name, bio, creator_type, created_at')
		.eq('creator_type', safeType)
		.order('created_at', { ascending: false })
		.limit(safeLimit);
	if (error) throw error;
	return data || [];
}

async function getTopPlatformCreators(limit = 5) {
	if (!isConfigured()) throw new Error('Supabase not configured');

	const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 20);

	const { data: creators, error } = await supabase
		.from('creators')
		.select('user_id, display_name')
		.limit(100);
	if (error) throw error;
	if (!creators || !creators.length) return [];

	// Count each creator's uploaded videos
	const withCounts = await Promise.all(
		creators.map(async (c) => {
			const { count } = await supabase
				.from('media')
				.select('id', { count: 'exact', head: true })
				.eq('user_id', c.user_id);
			return { ...c, videoCount: count || 0 };
		})
	);

	const top = withCounts
		.sort((a, b) => b.videoCount - a.videoCount)
		.slice(0, safeLimit);

	// Fetch profile pictures from Firebase RTDB
	const rtdb = getFirebaseRtdb();
	const result = await Promise.all(
		top.map(async (c) => {
			let avatar = null;
			if (rtdb) {
				try {
					const snap = await rtdb.ref(`users/${c.user_id}`).once('value');
					const val = snap.val();
					avatar = val?.avatar || val?.photoURL || null;
				} catch { /* no avatar — use null, frontend will fall back to dicebear */ }
			}
			return {
				id: c.user_id,
				name: c.display_name || 'Creator',
				avatar,
				videoCount: c.videoCount,
			};
		})
	);

	return result;
}

export {
	getCreator,
	upsertCreator,
	getCreatorsByType,
	getTopPlatformCreators,
	getWallet,
	incrementWallet,
	debitWallet,
	computeEarningsForHost
};

