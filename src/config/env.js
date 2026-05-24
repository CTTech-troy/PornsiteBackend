import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { isLocalUrl, isProductionEnv, validateAppUrlConfig } from '../utils/appUrls.js';

process.env.DOTENV_CONFIG_QUIET = process.env.DOTENV_CONFIG_QUIET || 'true';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '../..');
const repoRoot = path.resolve(backendRoot, '..');
const activeEnv = String(process.env.APP_ENV || process.env.NODE_ENV || 'production').toLowerCase();

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  dotenv.config({ path: filePath, quiet: true, override: false });
  return true;
}

const envFiles = [
  path.join(backendRoot, `.env.${activeEnv}`),
  path.join(repoRoot, `.env.${activeEnv}`),
  path.join(backendRoot, '.env'),
  path.join(repoRoot, '.env'),
];

const loaded = envFiles.filter(loadEnvFile);
if (loaded.length) {
  console.info(`[env] Loaded ${loaded.length} environment file(s) for ${activeEnv}.`);
}

function requireEnv(name, issues) {
  if (!String(process.env[name] || '').trim()) {
    issues.push(`${name} is required`);
  }
}

function requireHttpsUrl(name, issues) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    issues.push(`${name} is required`);
    return;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') issues.push(`${name} must use HTTPS`);
    if (isLocalUrl(value)) issues.push(`${name} must not resolve to a loopback URL`);
  } catch {
    issues.push(`${name} must be a valid absolute URL`);
  }
}

function validateProductionEnv() {
  if (!isProductionEnv()) return;
  const issues = [];

  [
    'FRONTEND_URL',
    'ADMIN_FRONTEND_URL',
    'BACKEND_PUBLIC_URL',
    'PAYMENT_SERVICE_URL',
    'SUPABASE_URL',
  ].forEach((name) => requireHttpsUrl(name, issues));

  [
    'SUPABASE_SERVICE_ROLE_KEY',
    'JWT_SECRET',
    'ADMIN_JWT_SECRET',
    'PAYMENT_SERVICE_SHARED_SECRET',
  ].forEach((name) => requireEnv(name, issues));

  if (issues.length) {
    throw new Error(`[env] Production configuration failed validation:\n- ${issues.join('\n- ')}`);
  }
}

validateAppUrlConfig();
validateProductionEnv();
