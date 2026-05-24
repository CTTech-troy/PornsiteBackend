import {
  deleteCreatorLeaderboardControl,
  getCreatorLeaderboardSettings,
  getTopCreatorsLeaderboard,
  invalidateTopCreatorsCache,
  listCreatorLeaderboardControls,
  updateCreatorLeaderboardSettings,
  upsertCreatorLeaderboardControl,
} from '../services/creatorLeaderboard.service.js';

function adminId(req) {
  return req.admin?.id || req.admin?.email || req.admin?.username || null;
}

export async function getLeaderboard(req, res) {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '25', 10) || 25, 1), 100);
    const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
    const result = await getTopCreatorsLeaderboard({ limit, page });
    return res.json(result);
  } catch (err) {
    console.error('[adminCreatorLeaderboard] getLeaderboard', err?.message || err);
    return res.status(500).json({ message: err?.message || 'Failed to load creator leaderboard.' });
  }
}

export async function getSettings(req, res) {
  try {
    const settings = await getCreatorLeaderboardSettings();
    return res.json({ settings });
  } catch (err) {
    console.error('[adminCreatorLeaderboard] getSettings', err?.message || err);
    return res.status(500).json({ message: err?.message || 'Failed to load leaderboard settings.' });
  }
}

export async function updateSettings(req, res) {
  try {
    const settings = await updateCreatorLeaderboardSettings(req.body || {}, adminId(req));
    return res.json({ message: 'Leaderboard settings saved.', settings });
  } catch (err) {
    console.error('[adminCreatorLeaderboard] updateSettings', err?.message || err);
    return res.status(500).json({ message: err?.message || 'Failed to save leaderboard settings.' });
  }
}

export async function getControls(req, res) {
  try {
    const controls = await listCreatorLeaderboardControls();
    return res.json({ controls });
  } catch (err) {
    console.error('[adminCreatorLeaderboard] getControls', err?.message || err);
    return res.status(500).json({ message: err?.message || 'Failed to load leaderboard controls.' });
  }
}

export async function upsertControl(req, res) {
  try {
    const payload = {
      ...(req.body || {}),
      creator_id: req.params.creatorId || req.body?.creator_id || req.body?.creatorId,
    };
    const control = await upsertCreatorLeaderboardControl(payload, adminId(req));
    return res.json({ message: 'Leaderboard control saved.', control });
  } catch (err) {
    console.error('[adminCreatorLeaderboard] upsertControl', err?.message || err);
    const status = /required|invalid/i.test(String(err?.message || '')) ? 400 : 500;
    return res.status(status).json({ message: err?.message || 'Failed to save leaderboard control.' });
  }
}

export async function deleteControl(req, res) {
  try {
    const result = await deleteCreatorLeaderboardControl(req.params.creatorId);
    return res.json({ message: 'Leaderboard control removed.', ...result });
  } catch (err) {
    console.error('[adminCreatorLeaderboard] deleteControl', err?.message || err);
    const status = /required/i.test(String(err?.message || '')) ? 400 : 500;
    return res.status(status).json({ message: err?.message || 'Failed to remove leaderboard control.' });
  }
}

export async function refreshLeaderboard(req, res) {
  try {
    invalidateTopCreatorsCache();
    const limit = Math.min(Math.max(parseInt(req.body?.limit || req.query.limit || '10', 10) || 10, 1), 100);
    const result = await getTopCreatorsLeaderboard({ limit, page: 1 });
    return res.json({ message: 'Leaderboard cache refreshed.', ...result });
  } catch (err) {
    console.error('[adminCreatorLeaderboard] refreshLeaderboard', err?.message || err);
    return res.status(500).json({ message: err?.message || 'Failed to refresh leaderboard.' });
  }
}
