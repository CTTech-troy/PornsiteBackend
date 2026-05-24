/**
 * End all active live sessions (Supabase + cache).
 * Run from backend folder: npm run exit-all-lives
 * Requires ADMIN_SECRET and BACKEND_PUBLIC_URL.
 */
import dotenv from 'dotenv';
dotenv.config();

const base = process.env.BASE_URL || process.env.BACKEND_PUBLIC_URL || 'https://pornsitebackend.onrender.com';
const secret = process.env.ADMIN_SECRET;

if (!secret) {
  console.error('Missing ADMIN_SECRET in .env');
  process.exit(1);
}

const res = await fetch(`${base}/api/live/cancel-all`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
  body: '{}',
}).catch((e) => {
  console.error('Request failed:', e.message);
  process.exit(1);
});

const data = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error('Error:', data.error || res.statusText);
  process.exit(1);
}
console.log('Exit all live sessions:', data);
process.exit(0);
