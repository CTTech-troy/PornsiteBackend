import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import authRouter from './src/router/auth.route.js';
import videosRouter from './src/router/videos.route.js';
import * as streamCtrl from './src/controller/stream.controller.js';
import liveRouter from './src/router/live.route.js';
import giftRouter from './src/router/gift.route.js';
import usersRouter from './src/router/users.route.js';
import creatorsRouter from './src/router/creators.route.js';
import postsRouter from './src/router/posts.route.js';
import pornhubRouter from './src/router/pornhubRoutes.js';
import contentRemovalRouter from './src/router/ContentRemoval.route.js';
import paymentRouter from './src/router/payment.route.js';
import messagesRouter from './src/router/messages.route.js';
import * as liveCtrl from './src/controller/live.controller.js';
import * as giftCtrl from './src/controller/gift.controller.js';
import * as walletsystem from './src/controller/walletsystem.controller.js';
import * as chatQueue from './src/controller/chatQueue.controller.js';
import { supabase, ensureBuckets } from './src/config/supabase.js';
import { syncCacheToSupabase } from './src/config/live-cache.js';
import { syncRtdbToSupabase } from './src/config/dbFallback.js';
import { printFirebaseStartupSummary } from './src/config/firebase.js';
import { pingServices } from './src/utils/servicePing.js';
import { pingPaymentService } from './src/services/paymentServiceClient.js';
import { resolveUidFromBearerToken } from './src/utils/sessionToken.js';
import { getAuthMetricsSnapshot } from './src/utils/authMetrics.js';

const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
 
// Secure HTTP headers
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

app.use(compression());

// SEC-02: Restrict CORS to allowed origins (comma-separated in env).
// Includes local dev + primary production frontend as safe defaults.
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://xstreamvideos.netlify.app',
];

function parseAllowedOrigins(rawOrigins) {
  const input = typeof rawOrigins === 'string' && rawOrigins.trim()
    ? rawOrigins
    : DEFAULT_ALLOWED_ORIGINS.join(',');
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.CORS_ORIGINS);
const allowedOriginsSet = new Set(ALLOWED_ORIGINS);

app.use(cors({
  origin(origin, callback) {
    // Allow requests with no origin (server-to-server, curl, mobile apps)
    if (!origin || allowedOriginsSet.has(origin)) return callback(null, true);
    callback(new Error(`Not allowed by CORS for origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  optionsSuccessStatus: 204,
}));
// Capture raw body bytes before JSON parsing so webhook handlers can verify
// HMAC signatures over the original bytes (not re-serialized JSON).
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}));

console.log(`Starting server in ${process.env.NODE_ENV || 'development'} mode`);

app.get('/', (req, res) => {
  res.send(`API running on port ${PORT}`);
});

app.get('/api/health/services', async (req, res) => {
  try {
    const { firebase, supabase } = await pingServices();
    res.json({
      firebase: {
        active: firebase.status === 'active',
        status: firebase.status,
        detail: firebase.detail
      },
      supabase: {
        active: supabase.status === 'active',
        status: supabase.status,
        detail: supabase.detail
      }
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.get('/api/health/auth-metrics', (req, res) => {
  if (process.env.AUTH_METRICS !== '1' && process.env.AUTH_METRICS !== 'true') {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json(getAuthMetricsSnapshot());
});

// Auth routes
app.use('/api/auth', authRouter);
app.get('/api/videos/stream/:id', (req, res) => streamCtrl.getStreamUrl(req, res));
// Videos proxy routes
app.use('/api/videos', videosRouter);
// Pornhub scraper routes
app.use('/api/pornhub', pornhubRouter);
// Live routes
app.use('/api/live', liveRouter);
// Gift catalog
app.use('/api/gifts', giftRouter);
// Users (public profile, follow)
app.use('/api/users', usersRouter);
// Creators (leaderboard + profile + videos)
app.use('/api/creators', creatorsRouter);
// User posts (RTDB + Supabase Storage; same persistence as /api/videos/upload)
app.use('/api/posts', postsRouter);
// Content Removal Requests
app.use('/api/contentRemoval', contentRemovalRouter);
// Payments (membership plans, checkout, webhooks — Paystack + Monnify)
app.use('/api/payments', paymentRouter);
// Creator messaging (authenticated users + creators)
app.use('/api/messages', messagesRouter);

const PORT = process.env.PORT || 3000;

let supabaseWarned = false;

function logServicePing(result) {
  const label = result.id === 'firebase' ? 'Firebase' : 'Supabase';
  if (result.status === 'active') {
    console.log(`✅ ${label}: active — ${result.detail}`);
  } else if (result.status === 'not_configured') {
    console.log(`ℹ️ ${label}: not configured — ${result.detail}`);
  } else {
    console.warn(`⚠️ ${label}: inactive — ${result.detail}`);
  }
}

async function checkConnections() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const keyLooksAnon =
    supabaseKey && !supabaseKey.startsWith('eyJ') && (supabaseKey.includes('publishable') || supabaseKey.includes('anon'));

  if (supabaseUrl && supabaseKey && !supabaseWarned) {
    if (keyLooksAnon) {
      supabaseWarned = true;
      console.warn('⚠️ Supabase: Use the secret "service_role" key (Dashboard → Settings → API) for Storage and DB.');
    } else {
      const url = supabaseUrl;
      if (url && (url.includes('/rest/v1') || !url.startsWith('https://') || url.endsWith('/'))) {
        supabaseWarned = true;
        console.warn('⚠️ Supabase: SUPABASE_URL should be https://YOUR_REF.supabase.co (no path, no trailing slash).');
      }
    }
  }

  const { firebase, supabase } = await pingServices();
  logServicePing(firebase);
  logServicePing(supabase);

  // --- Payment service health ---
  // Checkout creation is fully delegated to the C# payment service.
  // This is a non-blocking check — the backend starts regardless of whether
  // the payment service is reachable.
  const paymentHealth = await pingPaymentService();
  if (paymentHealth.ok) {
    console.log(`✅ Payment service: ${paymentHealth.detail}`);
  } else {
    console.warn(
      `⚠️  Payment service: ${paymentHealth.detail}\n` +
      `   → Checkout will fail until the service is running.\n` +
      `   → Set PAYMENT_SERVICE_URL in backend/.env and start the payment service.`
    );
  }
}

// Create HTTP server and attach socket.io (dynamic import with graceful fallback)
import http from 'http';

const server = http.createServer(app);
let io;
try {
  // dynamic import so the server can still start if socket.io isn't installed
  const mod = await import('socket.io');
  const Server = mod.Server || mod.default;
  io = new Server(server, {
    cors: {
      origin: ALLOWED_ORIGINS,
      methods: ['GET', 'POST'],
      credentials: true,
    }
  });

  // SEC-05: Socket.IO authentication middleware — verify token before connection
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
      if (!token) return next(new Error('Authentication required'));
      const uid = await resolveUidFromBearerToken(token);
      if (!uid) return next(new Error('Invalid or expired token'));
      socket.uid = uid;
      next();
    } catch (err) {
      next(new Error('Authentication failed'));
    }
  });

  app.set('io', io);

  // --- Random chat tracking maps ---
  // userId  → socket.id
  const userSocketMap = new Map();
  // userId  → { roomId }
  const userRoomMap   = new Map();
  // liveId  → host socket.id  (for WebRTC live signaling)
  const liveHostMap   = new Map();

  // Periodic stale-queue cleanup (every 30 s)
  setInterval(() => chatQueue.cleanupStaleQueue(30).catch(() => {}), 30_000);

  io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id, 'uid:', socket.uid);

    // Register socket for this user (needed so peers can look up the live socket)
    userSocketMap.set(socket.uid, socket.id);

  socket.on('join-live', async ({ liveId }) => {
    try {
      const userId = socket.uid; // authenticated — never trust client
      await socket.join(liveId);
      await liveCtrl.joinLive(liveId, userId);
      const session = await liveCtrl.getLiveSession(liveId);
      const viewersCount = session?.viewersCount ?? 0;
      io.to(liveId).emit('update-viewers', { viewersCount });
      io.to(liveId).emit('user_joined', { userId, session });
    } catch (err) {
      console.error('join-live error', err && err.message ? err.message : err);
      socket.emit('error', { message: String(err) });
    }
  });

  socket.on('leave-live', async ({ liveId }) => {
    try {
      const userId = socket.uid;
      await socket.leave(liveId);
      await liveCtrl.leaveLive(liveId, userId);
      const session = await liveCtrl.getLiveSession(liveId);
      const viewersCount = session?.viewersCount ?? 0;
      io.to(liveId).emit('update-viewers', { viewersCount });
      io.to(liveId).emit('user_left', { userId, session });
    } catch (err) {
      console.error('leave-live error', err && err.message ? err.message : err);
      socket.emit('error', { message: String(err) });
    }
  });

  socket.on('like-live', async ({ liveId }) => {
    try {
      await liveCtrl.likeLive(liveId);
      const live = await liveCtrl.getLive(liveId);
      io.to(liveId).emit('update-likes', { totalLikes: live?.total_likes || 0 });
    } catch (err) {
      console.error('like-live error', err && err.message ? err.message : err);
    }
  });

  socket.on('comment-live', async ({ liveId, message, authorName }) => {
    try {
      const userId = socket.uid; // authenticated — never trust client for identity
      // Sanitise display name supplied by the client (trust for display only, not identity)
      const safeAuthorName = typeof authorName === 'string' ? authorName.trim().slice(0, 80) : '';
      const comment = await liveCtrl.commentLive(liveId, userId, message);
      // Inject the author display name so all viewers see the real sender name
      const enriched = safeAuthorName
        ? { ...comment, authorName: safeAuthorName, author_name: safeAuthorName }
        : comment;
      io.to(liveId).emit('new-comment', enriched);
    } catch (err) {
      console.error('comment-live error', err && err.message ? err.message : err);
    }
  });

  socket.on('gift-live', async ({ liveId, giftType, quantity }) => {
    try {
      const senderId = socket.uid; // authenticated — never trust client senderId
      const giftDef = giftCtrl.getGift(giftType);
      if (!giftDef) {
        socket.emit('error', { message: 'Unknown gift type' });
        return;
      }
      const qty = Math.max(1, Number(quantity) || 1);
      
      const paymentResult = await walletsystem.processGiftPayment({ liveId, senderId, giftType, quantity: qty });
      
      const live = await liveCtrl.getLive(liveId);
      io.to(liveId).emit('new-gift', {
        gift: { ...giftDef, quantity: qty, amount: paymentResult.totalAmount, record: paymentResult.result },
        totalGiftsAmount: live?.total_gifts_amount || 0
      });
    } catch (err) {
      console.error('gift-live error', err && err.message ? err.message : err);
      socket.emit('error', { message: String(err?.message || err) });
    }
  });

  socket.on('end-live', async ({ liveId }) => {
    try {
      const live = await liveCtrl.getLive(liveId);
      if (live && String(live.host_id) !== String(socket.uid)) {
        socket.emit('error', { message: 'Only the host can end this live stream' });
        return;
      }
      const payout = await liveCtrl.endLive(liveId, { requesterId: socket.uid });
      liveHostMap.delete(liveId);
      io.to(liveId).emit('live_ended', { sessionId: liveId, payout });
      io.to(liveId).emit('live-ended', payout);
      io.emit('live_ended', { sessionId: liveId, payout });
      const sockets = await io.in(liveId).fetchSockets();
      sockets.forEach(s => s.leave(liveId));
    } catch (err) {
      console.error('end-live error', err && err.message ? err.message : err);
      socket.emit('error', { message: String(err?.message || err) });
    }
  });

  socket.on('pause-live', async ({ liveId }) => {
    try {
      const live = await liveCtrl.getLive(liveId);
      if (live && live.host_id !== socket.uid) {
        socket.emit('error', { message: 'Only the host can pause this live stream' });
        return;
      }
      await liveCtrl.pauseLive(liveId);
      io.to(liveId).emit('live-paused', { liveId });
    } catch (err) {
      console.error('pause-live error', err && err.message ? err.message : err);
    }
  });

  socket.on('resume-live', async ({ liveId }) => {
    try {
      const live = await liveCtrl.getLive(liveId);
      if (live && live.host_id !== socket.uid) {
        socket.emit('error', { message: 'Only the host can resume this live stream' });
        return;
      }
      await liveCtrl.resumeLive(liveId);
      io.to(liveId).emit('live-resumed', { liveId });
    } catch (err) {
      console.error('resume-live error', err && err.message ? err.message : err);
    }
  });

  // -----------------------------------------------------------------------
  // Random video-chat events
  // -----------------------------------------------------------------------

  /**
   * chat:find-match { gender }
   * Enqueue the user and attempt an immediate match.
   * Emits chat:matched (to both) or chat:waiting (to self).
   */
  socket.on('chat:find-match', async ({ gender = 'any' } = {}) => {
    try {
      const userId = socket.uid;

      // Update socket map (may have changed on reconnect)
      userSocketMap.set(userId, socket.id);

      // Put caller into the queue
      await chatQueue.enqueueUser(userId, gender, socket.id);

      // Try to find a partner
      const match = await chatQueue.dequeueAndMatch(userId, gender);

      if (!match) {
        // No partner yet — wait
        socket.emit('chat:waiting');
        return;
      }

      const { roomId, peerUserId, peerSocketId } = match;

      // Track room for both users
      userRoomMap.set(userId,     { roomId });
      userRoomMap.set(peerUserId, { roomId });

      // Join both sockets into the room
      socket.join(roomId);
      const peerSocket = io.sockets.sockets.get(peerSocketId);
      if (peerSocket) peerSocket.join(roomId);

      // Notify caller (initiator creates WebRTC offer)
      socket.emit('chat:matched', { roomId, initiator: true, peerId: peerUserId });

      // Notify partner
      if (peerSocket) {
        peerSocket.emit('chat:matched', { roomId, initiator: false, peerId: userId });
      } else {
        // Peer socket disconnected between queue entry and match — emit to room anyway
        io.to(roomId).emit('chat:matched', { roomId, initiator: false, peerId: userId });
      }
    } catch (err) {
      console.error('chat:find-match error:', err?.message || err);
      socket.emit('chat:error', { message: String(err?.message || err) });
    }
  });

  /**
   * chat:cancel
   * Remove the user from the queue without starting a match.
   */
  socket.on('chat:cancel', async () => {
    try {
      await chatQueue.dequeueUser(socket.uid);
      userRoomMap.delete(socket.uid);
    } catch (err) {
      console.error('chat:cancel error:', err?.message || err);
    }
  });

  /**
   * chat:signal { roomId, signal }
   * Relay a WebRTC signal (offer / answer / ICE candidate) to the peer.
   */
  socket.on('chat:signal', ({ roomId, signal } = {}) => {
    if (!roomId || !signal) return;
    // Relay to everyone else in the room (i.e., the peer)
    socket.to(roomId).emit('chat:signal', { signal, fromId: socket.uid });
  });

  /**
   * chat:next { roomId }
   * End the current chat and immediately re-enter the queue.
   * Notifies the peer, then emits chat:ended to the caller.
   */
  socket.on('chat:next', async ({ roomId } = {}) => {
    try {
      const userId = socket.uid;

      if (roomId) {
        await chatQueue.endChatRoom(roomId);
        socket.to(roomId).emit('chat:peer-left', { roomId });
        socket.leave(roomId);
        userRoomMap.delete(userId);
      }

      socket.emit('chat:ended', { roomId });
    } catch (err) {
      console.error('chat:next error:', err?.message || err);
      socket.emit('chat:error', { message: String(err?.message || err) });
    }
  });

  /**
   * chat:leave { roomId }
   * End the chat completely without re-queuing.
   */
  socket.on('chat:leave', async ({ roomId } = {}) => {
    try {
      const userId = socket.uid;

      if (roomId) {
        await chatQueue.endChatRoom(roomId);
        socket.to(roomId).emit('chat:peer-left', { roomId });
        socket.leave(roomId);
      }

      await chatQueue.dequeueUser(userId);
      userRoomMap.delete(userId);
      socket.emit('chat:ended', { roomId });
    } catch (err) {
      console.error('chat:leave error:', err?.message || err);
    }
  });

  /**
   * chat:message { roomId, text }
   * Relay a text message to the peer in the room.
   */
  socket.on('chat:message', ({ roomId, text } = {}) => {
    if (!roomId || !text) return;
    const safeText = String(text).slice(0, 500); // cap at 500 chars
    socket.to(roomId).emit('chat:message', {
      fromId: socket.uid,
      text:   safeText,
      ts:     Date.now(),
    });
  });

  // -----------------------------------------------------------------------
  // WebRTC live-stream signaling (host → viewers, peer-to-peer video)
  // -----------------------------------------------------------------------

  // Host explicitly registers their socket after creating/resuming a live session.
  // More reliable than inferring from join-live (which has async DB calls).
  socket.on('live:host-register', ({ liveId } = {}) => {
    if (!liveId) return;
    liveHostMap.set(liveId, socket.id);
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[WebRTC] Host ${socket.uid} registered for live ${liveId}`);
    }
  });

  // Relay periodic thumbnail snapshots from host camera to all live-list browsers.
  socket.on('live:thumbnail-update', ({ liveId, thumbnail } = {}) => {
    if (!liveId || !thumbnail || typeof thumbnail !== 'string') return;
    // Only the registered host for this live may push thumbnails
    if (liveHostMap.get(liveId) !== socket.id) return;
    // Broadcast to everyone (live-list browsers + viewers in room)
    io.emit('live:thumbnail-update', { liveId, thumbnail });
  });

  socket.on('live:viewer-ready', ({ liveId } = {}) => {
    if (!liveId) return;
    const hostSocketId = liveHostMap.get(liveId);
    if (!hostSocketId) return;
    const hostSocket = io.sockets.sockets.get(hostSocketId);
    if (hostSocket) hostSocket.emit('live:viewer-joined', { viewerSocketId: socket.id });
  });

  socket.on('live:signal', ({ liveId, signal, targetSocketId } = {}) => {
    if (!signal || !targetSocketId) return;
    const target = io.sockets.sockets.get(targetSocketId);
    if (target) target.emit('live:signal', { signal, fromSocketId: socket.id });
  });

  socket.on('live:ice', ({ candidate, targetSocketId } = {}) => {
    if (!candidate || !targetSocketId) return;
    const target = io.sockets.sockets.get(targetSocketId);
    if (target) target.emit('live:ice', { candidate, fromSocketId: socket.id });
  });

  socket.on('disconnect', async () => {
    console.log('Socket disconnected:', socket.id);

    const userId = socket.uid;
    userSocketMap.delete(userId);
    // Clean up any live host registration
    for (const [lid, sid] of liveHostMap) {
      if (sid === socket.id) { liveHostMap.delete(lid); break; }
    }

    // Clean up any active chat room
    const roomEntry = userRoomMap.get(userId);
    if (roomEntry) {
      const { roomId } = roomEntry;
      userRoomMap.delete(userId);
      try {
        await chatQueue.endChatRoom(roomId);
        io.to(roomId).emit('chat:peer-left', { roomId });
      } catch (err) {
        console.error('disconnect cleanup error:', err?.message || err);
      }
    }

    // Remove from queue if still waiting
    try { await chatQueue.dequeueUser(userId); } catch (_) {}
  });
  });
} catch (err) {
  console.warn('socket.io not available — running without real-time features:', err?.message || err);
  io = {
    to: () => ({ emit: () => {} }),
    in: () => ({ fetchSockets: async () => [] }),
    on: () => {},
    emit: () => {}
  };
  app.set('io', io);
}

// MED-01: Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err && err.message ? err.message : err);
  res.status(err.status || 500).json({
    ok: false,
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : (err.message || 'Unknown error')
  });
});

server.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  printFirebaseStartupSummary();
  await checkConnections();
  ensureBuckets().then(() => {}).catch(() => {});
  syncCacheToSupabase().catch(() => {});
  syncRtdbToSupabase().catch(() => {});
// MED-09: Removed the 60-second interval block. Sync now only happens safely at startup or explicitly via manual invocation.
});

// MED-10: Graceful shutdown
async function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  try {
    console.log('Force-syncing caches to Supabase...');
    await syncCacheToSupabase();
    await syncRtdbToSupabase();
  } catch (err) {
    console.error('Error during shutdown sync:', err?.message || err);
  }
  server.close(() => {
    console.log('Closed out remaining connections.');
    process.exit(0);
  });
  
  // Force exit if taking too long
  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
