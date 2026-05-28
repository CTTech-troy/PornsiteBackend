import '../src/config/env.js';
import { startEnterpriseImportWorker } from '../src/services/enterpriseImportWorker.service.js';
import {
  assertEnterpriseImportSchemaReady,
  expireStaleUploadSessions,
} from '../src/services/enterpriseImport.service.js';
import {
  assertEnterpriseImportQueueReady,
  getEnterpriseImportQueueHealth,
  reconcileEnterpriseImportQueue,
} from '../src/services/enterpriseImportQueue.service.js';
import {
  getR2ImportStorageStatus,
  validateR2ImportBucket,
} from '../src/services/r2ImportStorage.service.js';
import { getSupabaseStatus } from '../src/config/supabase.js';

const controller = new AbortController();

process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());

async function runCleanupLoop() {
  const intervalMs = Number(process.env.IMPORT_CLEANUP_INTERVAL_MS || 10 * 60 * 1000);
  while (!controller.signal.aborted) {
    try {
      await expireStaleUploadSessions();
    } catch (error) {
      console.warn('[enterprise-import-worker] cleanup failed:', error?.message || error);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const r2Status = getR2ImportStorageStatus();

console.info('[enterprise-import-worker] starting', {
  supabase: getSupabaseStatus(),
  r2: r2Status,
  concurrency: Number(process.env.IMPORT_WORKER_CONCURRENCY || 1),
});

if (!r2Status.configured) {
  console.error('[enterprise-import-worker] Cloudflare R2 import storage is not configured.', {
    missing: r2Status.missing,
  });
  process.exit(1);
}

try {
  console.info('[enterprise-import-worker] R2 bucket validation ok', await validateR2ImportBucket());
} catch (error) {
  console.error('[enterprise-import-worker] R2 bucket validation failed:', error?.message || error);
  process.exit(1);
}

try {
  console.info('[enterprise-import-worker] Redis queue validation ok', await assertEnterpriseImportQueueReady());
  await reconcileEnterpriseImportQueue({ source: 'worker-startup' });
  console.info('[enterprise-import-worker] Queue health', await getEnterpriseImportQueueHealth());
} catch (error) {
  console.error('[enterprise-import-worker] Redis queue validation failed:', error?.message || error);
  process.exit(1);
}

try {
  await assertEnterpriseImportSchemaReady();
  console.info('[enterprise-import-worker] Enterprise import schema validation ok');
} catch (error) {
  console.error('[enterprise-import-worker] Enterprise import schema validation failed:', error?.message || error);
  process.exit(1);
}

await Promise.all([
  startEnterpriseImportWorker({ signal: controller.signal }),
  runCleanupLoop(),
]);
