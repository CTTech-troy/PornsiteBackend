const MB = 1024 * 1024;

function toMb(value) {
  return Math.round((Number(value) || 0) / MB);
}

export function getMemoryDiagnostics() {
  const usage = process.memoryUsage();
  return {
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    rssMb: toMb(usage.rss),
    heapTotalMb: toMb(usage.heapTotal),
    heapUsedMb: toMb(usage.heapUsed),
    externalMb: toMb(usage.external),
    arrayBuffersMb: toMb(usage.arrayBuffers),
  };
}

export function logMemoryUsage(label = 'runtime', extra = {}) {
  console.info('[memory]', {
    label,
    ...getMemoryDiagnostics(),
    ...extra,
  });
}

export function startMemoryDiagnostics({
  intervalMs = Number(process.env.MEMORY_DIAGNOSTICS_INTERVAL_MS || 0),
  warnHeapUsedMb = Number(process.env.MEMORY_WARN_HEAP_USED_MB || 512),
} = {}) {
  const ms = Number(intervalMs);
  if (!Number.isFinite(ms) || ms <= 0) return null;

  const timer = setInterval(() => {
    const snapshot = getMemoryDiagnostics();
    const level = snapshot.heapUsedMb >= warnHeapUsedMb ? 'warn' : 'info';
    console[level]('[memory]', {
      label: 'periodic',
      ...snapshot,
      warnHeapUsedMb,
    });
  }, Math.max(10_000, ms));

  timer.unref?.();
  return timer;
}
