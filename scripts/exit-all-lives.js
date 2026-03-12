/**
 * End all active live sessions (Supabase + cache).
 * Run from backend folder: npm run exit-all-lives
 * Requires ADMIN_SECRET in .env and server running on PORT (default 5000).
 */
import dotenv from 'dotenv';
dotenv.config();

const PORT = process.env.PORT || 5000;
const base = `http://localhost:${PORT}`;
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
