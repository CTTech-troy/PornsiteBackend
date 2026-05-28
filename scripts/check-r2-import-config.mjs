import '../src/config/env.js';
import {
  createR2SignedUploadDiagnosticsUrl,
  getR2ImportStorageStatus,
  validateR2ImportBucket,
} from '../src/services/r2ImportStorage.service.js';

const status = getR2ImportStorageStatus();
console.log('[r2-import] dotenv loaded and R2 env scanned:', status);

if (!status.configured) {
  console.error(`[r2-import] Missing required env variables: ${status.missing.join(', ')}`);
  process.exit(1);
}

try {
  const bucket = await validateR2ImportBucket();
  console.log('[r2-import] Bucket validation succeeded:', bucket);

  const signed = await createR2SignedUploadDiagnosticsUrl();
  console.log('[r2-import] Signed multipart upload URL generation succeeded:', signed);
} catch (error) {
  console.error('[r2-import] Validation failed:', error?.message || error);
  process.exit(1);
}
