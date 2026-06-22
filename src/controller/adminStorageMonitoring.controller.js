import {
  forceBackupMedia,
  getStorageMonitoringOverview,
  listStorageReplicationLogs,
  retryFailedReplications,
  validateR2MediaBucket,
} from '../services/mediaRedundancy.service.js';
import { writePlatformActivityEvent } from '../services/platformActivity.service.js';

export async function overview(req, res) {
  try {
    const data = await getStorageMonitoringOverview();
    return res.json(data);
  } catch (err) {
    return res.status(err?.status || 500).json({ message: err?.message || 'Failed to load storage monitoring' });
  }
}

export async function health(req, res) {
  try {
    const r2 = await validateR2MediaBucket();
    return res.json({ r2 });
  } catch (err) {
    return res.status(err?.status || 500).json({ message: err?.message || 'Storage health check failed' });
  }
}

export async function retryFailed(req, res) {
  try {
    const result = await retryFailedReplications(req.body?.limit || 25);
    await writePlatformActivityEvent({
      eventType: 'storage_replication_retry',
      title: 'Storage replication retry queued',
      message: `${result.queued} failed replication(s) queued`,
      actorId: req.admin?.user_id || req.admin?.sub || null,
      targetType: 'storage',
      targetId: 'r2',
    }).catch(() => null);
    return res.json(result);
  } catch (err) {
    return res.status(err?.status || 500).json({ message: err?.message || 'Failed to retry replications' });
  }
}

export async function forceBackup(req, res) {
  try {
    const result = await forceBackupMedia({ limit: req.body?.limit || 50 });
    await writePlatformActivityEvent({
      eventType: 'storage_force_backup',
      title: 'Storage backup queued',
      message: `${result.queued} media item(s) queued`,
      actorId: req.admin?.user_id || req.admin?.sub || null,
      targetType: 'storage',
      targetId: 'r2',
    }).catch(() => null);
    return res.json(result);
  } catch (err) {
    return res.status(err?.status || 500).json({ message: err?.message || 'Failed to force backup' });
  }
}

export async function logs(req, res) {
  try {
    const data = await listStorageReplicationLogs(req.query?.limit || 100);
    return res.json({ logs: data });
  } catch (err) {
    return res.status(err?.status || 500).json({ message: err?.message || 'Failed to load storage logs' });
  }
}
