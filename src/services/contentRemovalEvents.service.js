const clients = new Set();

function safeJson(data) {
  try {
    return JSON.stringify(data);
  } catch {
    return '{}';
  }
}

export function subscribeContentRemovalEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const client = { res };
  clients.add(client);
  res.write(`event: content-removal:connected\ndata: ${safeJson({ ok: true, ts: Date.now() })}\n\n`);

  const heartbeat = setInterval(() => {
    res.write(`event: content-removal:heartbeat\ndata: ${safeJson({ ts: Date.now() })}\n\n`);
  }, 25_000);
  heartbeat.unref?.();

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(client);
  });
}

export function emitContentRemovalEvent(io, eventName, request, extra = {}) {
  const event = eventName || 'content-removal:updated';
  const payload = {
    event,
    request,
    ...extra,
    ts: Date.now(),
  };

  for (const client of Array.from(clients)) {
    try {
      client.res.write(`event: ${event}\ndata: ${safeJson(payload)}\n\n`);
    } catch {
      clients.delete(client);
    }
  }

  try {
    io?.emit?.(event, payload);
  } catch (_) {}
}
