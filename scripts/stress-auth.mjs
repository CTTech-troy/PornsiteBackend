/**
 * Quick concurrency probe for auth endpoints (no real credentials).
 * Usage: BASE_URL=http://localhost:5000 node scripts/stress-auth.mjs [concurrency] [requests]
 */
const base = (process.env.BASE_URL || 'http://localhost:5000').replace(/\/$/, '');
const concurrent = Math.max(1, parseInt(process.argv[2] || '50', 10));
const total = Math.max(concurrent, parseInt(process.argv[3] || '200', 10));

async function one(i) {
  const t0 = performance.now();
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: 'invalid-token-probe-' + i }),
  });
  const ms = performance.now() - t0;
  return { status: r.status, ms };
}

async function main() {
  const indices = Array.from({ length: total }, (_, i) => i);
  const latencies = [];
  const started = performance.now();
  for (let offset = 0; offset < indices.length; offset += concurrent) {
    const batch = indices.slice(offset, offset + concurrent);
    const results = await Promise.all(batch.map((i) => one(i)));
    results.forEach((r) => latencies.push(r.ms));
  }
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const elapsed = (performance.now() - started) / 1000;
  console.log(JSON.stringify({
    base,
    concurrent,
    totalRequests: total,
    seconds: +elapsed.toFixed(2),
    rps: +(total / elapsed).toFixed(1),
    latencyMs: { p50: +p50.toFixed(1), p95: +p95.toFixed(1), max: +latencies[latencies.length - 1].toFixed(1) },
    note: 'Invalid idToken -> fast 401 path; measures throughput and rate-limit behavior, not full login.',
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
