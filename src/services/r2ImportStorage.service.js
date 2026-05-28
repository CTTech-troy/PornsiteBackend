import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import '../config/env.js';

function trim(value) {
  return String(value || '').trim();
}

const REQUIRED_R2_ENV = [
  'CLOUDFLARE_R2_ACCOUNT_ID',
  'CLOUDFLARE_R2_ENDPOINT',
  'CLOUDFLARE_R2_ACCESS_KEY_ID',
  'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
  'CLOUDFLARE_R2_IMPORT_BUCKET',
];

function readR2Env() {
  const accountId = trim(process.env.CLOUDFLARE_R2_ACCOUNT_ID);
  return {
    accountId,
    endpoint: trim(process.env.CLOUDFLARE_R2_ENDPOINT || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '')).replace(/\/+$/, ''),
    accessKeyId: trim(process.env.CLOUDFLARE_R2_ACCESS_KEY_ID),
    secretAccessKey: trim(process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY),
    bucket: trim(process.env.CLOUDFLARE_R2_IMPORT_BUCKET),
    region: trim(process.env.CLOUDFLARE_R2_REGION) || 'auto',
  };
}

const r2Env = readR2Env();
export const R2_IMPORT_BUCKET = r2Env.bucket;

export const R2_UPLOAD_PART_URL_TTL_SECONDS = Math.max(
  60,
  Math.min(3600, Number(process.env.CLOUDFLARE_R2_UPLOAD_PART_URL_TTL_SECONDS || 15 * 60)),
);

let client = null;

export function getMissingR2ImportEnvVars() {
  const env = readR2Env();
  return REQUIRED_R2_ENV.filter((name) => {
    if (name === 'CLOUDFLARE_R2_ENDPOINT') return !env.endpoint;
    if (name === 'CLOUDFLARE_R2_IMPORT_BUCKET') return !env.bucket;
    if (name === 'CLOUDFLARE_R2_ACCOUNT_ID') return !env.accountId;
    if (name === 'CLOUDFLARE_R2_ACCESS_KEY_ID') return !env.accessKeyId;
    if (name === 'CLOUDFLARE_R2_SECRET_ACCESS_KEY') return !env.secretAccessKey;
    return !trim(process.env[name]);
  });
}

export function isR2ImportStorageConfigured() {
  return getMissingR2ImportEnvVars().length === 0;
}

export function getR2ImportStorageStatus() {
  const env = readR2Env();
  const missing = getMissingR2ImportEnvVars();
  return {
    configured: missing.length === 0,
    missing,
    endpointConfigured: Boolean(env.endpoint),
    bucketConfigured: Boolean(env.bucket),
    accessKeyConfigured: Boolean(env.accessKeyId),
    secretKeyConfigured: Boolean(env.secretAccessKey),
    accountIdConfigured: Boolean(env.accountId),
    endpointHost: env.endpoint ? new URL(env.endpoint).hostname : null,
    bucket: env.bucket || null,
    region: env.region,
  };
}

export function assertR2ImportStorageConfigured() {
  const missing = getMissingR2ImportEnvVars();
  if (!missing.length) return;
  throw new Error(`Cloudflare R2 import storage is not configured. Missing: ${missing.join(', ')}`);
}

export function getR2ImportClient() {
  assertR2ImportStorageConfigured();
  const env = readR2Env();
  if (!client) {
    client = new S3Client({
      region: env.region,
      endpoint: env.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.accessKeyId,
        secretAccessKey: env.secretAccessKey,
      },
    });
  }
  return client;
}

export async function validateR2ImportBucket() {
  const env = readR2Env();
  const startedAt = Date.now();
  await getR2ImportClient().send(new HeadBucketCommand({
    Bucket: env.bucket,
  }));
  return {
    ok: true,
    bucket: env.bucket,
    endpointHost: env.endpoint ? new URL(env.endpoint).hostname : null,
    latencyMs: Date.now() - startedAt,
  };
}

export async function createR2SignedUploadDiagnosticsUrl() {
  const key = `imports/diagnostics/${Date.now()}-part-check.csv`;
  const created = await createR2MultipartUpload({
    key,
    contentType: 'text/csv',
    metadata: { purpose: 'diagnostics' },
  });
  try {
    const url = await createR2UploadPartUrl({
      key,
      uploadId: created.uploadId,
      partNumber: 1,
      expiresIn: 60,
    });
    return {
      ok: Boolean(url),
      urlCreated: Boolean(url),
      key,
    };
  } finally {
    await abortR2MultipartUpload({ key, uploadId: created.uploadId }).catch(() => {});
  }
}

export async function createR2MultipartUpload({ key, contentType, metadata = {} }) {
  const command = new CreateMultipartUploadCommand({
    Bucket: R2_IMPORT_BUCKET,
    Key: key,
    ContentType: contentType || 'text/csv',
    Metadata: Object.fromEntries(
      Object.entries(metadata || {})
        .filter(([, value]) => value != null)
        .map(([name, value]) => [String(name).toLowerCase(), String(value).slice(0, 2048)]),
    ),
  });
  const result = await getR2ImportClient().send(command);
  return {
    bucket: R2_IMPORT_BUCKET,
    key,
    uploadId: result.UploadId,
  };
}

export async function createR2UploadPartUrl({ key, uploadId, partNumber, expiresIn = R2_UPLOAD_PART_URL_TTL_SECONDS }) {
  const safePartNumber = Number(partNumber);
  if (!Number.isInteger(safePartNumber) || safePartNumber < 1 || safePartNumber > 10000) {
    throw new Error(`Invalid multipart part number: ${partNumber}`);
  }
  const command = new UploadPartCommand({
    Bucket: R2_IMPORT_BUCKET,
    Key: key,
    UploadId: uploadId,
    PartNumber: safePartNumber,
  });
  return getSignedUrl(getR2ImportClient(), command, { expiresIn });
}

export async function completeR2MultipartUpload({ key, uploadId, parts }) {
  const normalizedParts = (Array.isArray(parts) ? parts : [])
    .map((part) => ({
      PartNumber: Number(part.partNumber ?? part.PartNumber),
      ETag: String(part.etag ?? part.ETag ?? '').trim(),
    }))
    .filter((part) => Number.isInteger(part.PartNumber) && part.PartNumber > 0 && part.ETag)
    .sort((a, b) => a.PartNumber - b.PartNumber);

  if (!normalizedParts.length) throw new Error('At least one uploaded part is required');

  return getR2ImportClient().send(new CompleteMultipartUploadCommand({
    Bucket: R2_IMPORT_BUCKET,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: {
      Parts: normalizedParts,
    },
  }));
}

export async function abortR2MultipartUpload({ key, uploadId }) {
  if (!key || !uploadId) return null;
  return getR2ImportClient().send(new AbortMultipartUploadCommand({
    Bucket: R2_IMPORT_BUCKET,
    Key: key,
    UploadId: uploadId,
  }));
}

export async function listR2MultipartUploadParts({ key, uploadId }) {
  if (!key || !uploadId) return [];
  const parts = [];
  let marker;

  do {
    const result = await getR2ImportClient().send(new ListPartsCommand({
      Bucket: R2_IMPORT_BUCKET,
      Key: key,
      UploadId: uploadId,
      PartNumberMarker: marker,
      MaxParts: 1000,
    }));

    for (const part of result.Parts || []) {
      parts.push({
        partNumber: Number(part.PartNumber || 0),
        etag: String(part.ETag || '').trim(),
        size: Number(part.Size || 0),
        lastModified: part.LastModified || null,
      });
    }

    marker = result.IsTruncated ? result.NextPartNumberMarker : null;
  } while (marker);

  return parts
    .filter((part) => Number.isInteger(part.partNumber) && part.partNumber > 0 && part.etag)
    .sort((a, b) => a.partNumber - b.partNumber);
}

export async function headR2Object(key) {
  const result = await getR2ImportClient().send(new HeadObjectCommand({
    Bucket: R2_IMPORT_BUCKET,
    Key: key,
  }));
  return {
    contentLength: Number(result.ContentLength || 0),
    contentType: result.ContentType || null,
    etag: result.ETag || null,
    lastModified: result.LastModified || null,
    metadata: result.Metadata || {},
  };
}

export async function openR2ObjectStream(key) {
  const result = await getR2ImportClient().send(new GetObjectCommand({
    Bucket: R2_IMPORT_BUCKET,
    Key: key,
  }));
  if (!result.Body) throw new Error('R2 object returned an empty body');
  return {
    stream: result.Body,
    contentLength: Number(result.ContentLength || 0) || null,
    contentType: result.ContentType || null,
    etag: result.ETag || null,
  };
}

export async function deleteR2Object(key) {
  if (!key) return null;
  return getR2ImportClient().send(new DeleteObjectCommand({
    Bucket: R2_IMPORT_BUCKET,
    Key: key,
  }));
}
