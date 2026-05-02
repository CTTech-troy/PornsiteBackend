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
import tokensRouter  from './src/router/tokens.route.js';
import messagesRouter from './src/router/messages.route.js';
import earningsRouter from './src/router/earnings.route.js';
import adminRouter from './src/router/admin.route.js';
import adsRouter from './src/router/ads.route.js';
import { publicMembershipsRouter, adminMembershipsRouter } from './src/router/memberships.route.js';
import financeRouter from './src/router/finance.route.js';
import creatorStudioRouter from './src/router/creatorStudio.route.js';
import adminUsersRouter from './src/router/adminUsers.route.js';
import adminContentRouter from './src/router/adminContent.route.js';
import adminModerationRouter from './src/router/adminModeration.route.js';
import adminSystemRouter from './src/router/adminSystem.route.js';
import * as liveCtrl from './src/controller/live.controller.js';
import { creditLiveEarnings } from './src/controller/earnings.controller.js';
import * as giftCtrl from './src/controller/gift.controller.js';
import * as walletsystem from './src/controller/walletsystem.controller.js';
import * as chatQueue from './src/controller/chatQueue.controller.js';
import { supabase, ensureBuckets } from './src/config/supabase.js';
import { syncCacheToSupabase } from './src/config/live-cache.js';
import { syncRtdbToSupabase } from './src/config/dbFallback.js';
import { printFirebaseStartupSummary } from './src/config/firebase.js';
import { pingServices } from './src/utils/servicePing.js';
import { pingPaymentService, STARTUP_HEALTH_TIMEOUT_MS } from './src/services/paymentServiceClient.js';
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
  'http://localhost:5174',
  'http://localhost:5176',
  'http://localhost:3000',
  'https://xstreamvideos.netlify.app',
  'https://pornsite-two.vercel.app',
  'https://xstreamvideos.site',
];


function parseAllowedOrigins(rawOrigins) {
  const envList =
    typeof rawOrigins === 'string' && rawOrigins.trim()
      ? rawOrigins
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  // Always include safe defaults, even if env is set.
  return Array.from(new Set([...DEFAULT_ALLOWED_ORIGINS, ...envList]));
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
app.use('/api/admin', adminRouter);
app.use('/api/admin/finance', financeRouter);
app.use('/api/admin', adminUsersRouter);
app.use('/api/admin/content', adminContentRouter);
app.use('/api/admin/moderation', adminModerationRouter);
app.use('/api/admin/system', adminSystemRouter);
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
// Token system (balance, send-gift, purchase packages)
app.use('/api/tokens', tokensRouter);
// Creator messaging (authenticated users + creators)
app.use('/api/messages', messagesRouter);
// Creator earnings
app.use('/api/earnings', earningsRouter);
// Creator Studio (analytics, withdrawals, settings)
app.use('/api/studio', creatorStudioRouter);
// Ads system (ad serving + impression/click tracking)
app.use('/api/ads', adsRouter);
// Membership plans (public read + admin CRUD)
app.use('/api/memberships', publicMembershipsRouter);
app.use('/api/admin/memberships', adminMembershipsRouter);

// LiveKit access token — called by both host and viewer before connecting to a room
app.post('/api/live/livekit-token', async (req, res) => {
  try {
    const { liveId, userId, isHost } = req.body;
    if (!liveId || !userId) {
      return res.status(400).json({ error: 'liveId and userId are required' });
    }
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!apiKey || !apiSecret) {
      return res.status(503).json({ error: 'LiveKit is not configured on this server. Set LIVEKIT_API_KEY and LIVEKIT_API_SECRET.' });
    }
    const { AccessToken } = await import('livekit-server-sdk');
    const at = new AccessToken(apiKey, apiSecret, {
      identity: String(userId),
      ttl: '4h',
    });
    at.addGrant({
      roomJoin: true,
      room: String(liveId),
      canPublish: !!isHost,
      canSubscribe: true,
      canPublishData: !!isHost,
    });
    const token = await at.toJwt();
    console.log(`[LiveKit] Token issued — room:${liveId} identity:${userId} host:${!!isHost}`);
    res.json({ token });
  } catch (err) {
    console.error('[LiveKit] Token error:', err?.message || err);
    res.status(500).json({ error: String(err?.message || 'Token generation failed') });
  }
});

// LiveKit access token for random 1-on-1 chat rooms.
// Unlike live streaming, BOTH participants can publish and subscribe.
app.post('/api/chat/livekit-token', async (req, res) => {
  try {
    const { roomId, userId } = req.body;
    if (!roomId || !userId) {
      return res.status(400).json({ error: 'roomId and userId are required' });
    }
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!apiKey || !apiSecret) {
      return res.status(503).json({ error: 'LiveKit is not configured on this server. Set LIVEKIT_API_KEY and LIVEKIT_API_SECRET.' });
    }
    const { AccessToken } = await import('livekit-server-sdk');
    const at = new AccessToken(apiKey, apiSecret, {
      identity: String(userId),
      ttl: '2h',
    });
    at.addGrant({
      roomJoin: true,
      room: String(roomId),
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    const token = await at.toJwt();
    console.log(`[LiveKit] Chat token issued — room:${roomId} identity:${userId}`);
    res.json({ token });
  } catch (err) {
    console.error('[LiveKit] Chat token error:', err?.message || err);
    res.status(500).json({ error: String(err?.message || 'Token generation failed') });
  }
});

// Default to 5043 for local/dev consistency (override with PORT env).
const PORT = process.env.PORT || 5043;

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
  // Non-blocking warmup ping — allows up to 60s for Render free-tier cold starts.
  console.log(`⏳ Payment service: warming up (up to 60s for cold start)…`);
  const paymentHealth = await pingPaymentService({ timeoutMs: STARTUP_HEALTH_TIMEOUT_MS });
  if (paymentHealth.ok) {
    console.log(`✅ Payment service: ${paymentHealth.detail}`);
  } else {
    console.warn(
      `⚠️  Payment service: ${paymentHealth.detail}\n` +
      `   → Checkout requests will fail until the service responds.\n` +
      `   → Check https://pornsite-paymentsystem-1.onrender.com/health`
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

  // SEC-05: Socket.IO authentication middleware — authenticated users get full access; guests can watch live
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
      if (token) {
        const uid = await resolveUidFromBearerToken(token);
        if (uid) {
          socket.uid = uid;
          socket.isGuest = false;
          return next();
        }
      }
      // Allow unauthenticated guests as read-only viewers (watch live, no comments/gifts)
      socket.uid = `guest:${socket.id}`;
      socket.isGuest = true;
      next();
    } catch (err) {
      socket.uid = `guest:${socket.id}`;
      socket.isGuest = true;
      next();
    }
  });

  app.set('io', io);

  // --- Random chat tracking maps ---
  // userId  → socket.id
  const userSocketMap = new Map();
  // userId  → { roomId }
  const userRoomMap   = new Map();
  // liveId  → host socket.id  (for thumbnail auth — only registered host may push thumbnails)
  const liveHostMap   = new Map();
  // socketId → Set<liveId>  (tracks which live rooms each socket joined, for disconnect cleanup)
  const socketLiveRooms = new Map();

  // Returns the number of viewers in a live room using Socket.IO's authoritative room size.
  // The host's own socket is excluded from the count.
  function roomViewerCount(liveId) {
    const room = io.sockets.adapter.rooms.get(liveId);
    if (!room) return 0;
    const hostSocketId = liveHostMap.get(liveId);
    if (hostSocketId && room.has(hostSocketId)) return Math.max(0, room.size - 1);
    return room.size;
  }

  // --- In-memory chat queue fallback ---
  // Used when Supabase chat_queue schema is not applied yet.
  // userId → { socketId, gender, ts }
  const memQueue = new Map();

  function memEnqueue(userId, gender, socketId) {
    memQueue.set(userId, { socketId, gender, ts: Date.now() });
  }

  function memDequeue(userId) {
    memQueue.delete(userId);
  }

  function memMatch(userId, gender) {
    for (const [pid, entry] of memQueue) {
      if (pid === userId) continue;
      if (gender !== 'any' && entry.gender !== 'any' && entry.gender !== gender) continue;
      memQueue.delete(pid);
      memQueue.delete(userId);
      const roomId = `mem-room-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return { roomId, peerUserId: pid, peerSocketId: entry.socketId };
    }
    return null;
  }

  // Periodic stale-queue cleanup (every 30 s)
  setInterval(() => {
    chatQueue.cleanupStaleQueue(30).catch(() => {});
    // Also clean memory queue entries older than 60 s
    const staleAge = Date.now() - 60_000;
    for (const [uid, entry] of memQueue) {
      if (entry.ts < staleAge) memQueue.delete(uid);
    }
  }, 30_000);

  io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id, 'uid:', socket.uid);

    // Register socket for this user (needed so peers can look up the live socket)
    userSocketMap.set(socket.uid, socket.id);

  socket.on('join-live', async ({ liveId }) => {
    try {
      const userId = socket.uid;
      await socket.join(liveId);

      // Track this socket's live membership for disconnect cleanup
      if (!socketLiveRooms.has(socket.id)) socketLiveRooms.set(socket.id, new Set());
      socketLiveRooms.get(socket.id).add(liveId);

      // Update DB in the background (fire-and-forget) — count comes from Socket.IO room
      if (!socket.isGuest) {
        liveCtrl.joinLive(liveId, userId).catch(() => {});
      }

      // Use Socket.IO room size as the single source of truth — counts guests + auth users
      const viewersCount = roomViewerCount(liveId);
      io.to(liveId).emit('update-viewers', { viewersCount });
      io.to(liveId).emit('user_joined', { userId, viewersCount });
    } catch (err) {
      console.error('join-live error', err && err.message ? err.message : err);
      socket.emit('error', { message: String(err) });
    }
  });

  socket.on('leave-live', async ({ liveId }) => {
    try {
      const userId = socket.uid;
      await socket.leave(liveId);

      socketLiveRooms.get(socket.id)?.delete(liveId);

      if (!socket.isGuest) {
        liveCtrl.leaveLive(liveId, userId).catch(() => {});
      }

      const viewersCount = roomViewerCount(liveId);
      io.to(liveId).emit('update-viewers', { viewersCount });
      io.to(liveId).emit('user_left', { userId, viewersCount });
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
      if (socket.isGuest) return; // guests cannot comment
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

  socket.on('gift-live', async ({ liveId, giftType, quantity, amount, name, emoji, senderName, tokenPaid }) => {
    try {
      if (socket.isGuest) { socket.emit('error', { message: 'Sign in to send gifts' }); return; }
      const senderId = socket.uid;
      const qty      = Math.max(1, Number(quantity) || 1);
      const giftAmt  = Number(amount) || 0;

      // Resolve gift definition; token-system gifts aren't in the old catalog so fall back to payload data
      const giftDef = giftCtrl.getGift(giftType) || { id: giftType, name: name || giftType, emoji: emoji || '🎁' };

      let totalGiftsAmount = giftAmt;
      if (tokenPaid) {
        // Payment already processed via HTTP /api/tokens/send-gift — just update the live total
        try {
          await liveCtrl.sendGift(liveId, senderId, giftType, giftAmt);
          const live = await liveCtrl.getLive(liveId);
          totalGiftsAmount = live?.total_gifts_amount ?? giftAmt;
        } catch { /* ignore DB update failures — broadcast still happens */ }
      } else {
        // Legacy coin-based path
        try {
          const paymentResult = await walletsystem.processGiftPayment({ liveId, senderId, giftType, quantity: qty });
          const live = await liveCtrl.getLive(liveId);
          totalGiftsAmount = live?.total_gifts_amount ?? paymentResult.totalAmount;
        } catch (payErr) {
          console.error('gift-live payment error:', payErr?.message || payErr);
          socket.emit('error', { message: String(payErr?.message || payErr) });
          return;
        }
      }

      io.to(liveId).emit('new-gift', {
        gift: {
          ...giftDef,
          quantity:   qty,
          amount:     giftAmt,
          senderId,
          senderName: senderName || 'Viewer',
          emoji:      emoji || giftDef.emoji || '🎁',
          name:       name  || giftDef.name  || 'Gift',
        },
        senderName:       senderName || 'Viewer',
        emoji:            emoji || giftDef.emoji || '🎁',
        giftName:         name  || giftDef.name  || 'Gift',
        amount:           giftAmt,
        totalGiftsAmount,
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

      // Credit 70% of total gifts to creator earnings (gifts are in NGN, converted to USD)
      if (live?.host_id) {
        const totalGiftsNgn = live.total_gifts_amount ?? 0;
        if (totalGiftsNgn > 0) {
          creditLiveEarnings(live.host_id, totalGiftsNgn, liveId).catch((e) =>
            console.warn('[earnings] creditLiveEarnings failed:', e?.message)
          );
        }
      }

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
      userSocketMap.set(userId, socket.id);

      let match = null;

      // Try Supabase-backed queue first; fall back to in-memory if unavailable
      try {
        await chatQueue.enqueueUser(userId, gender, socket.id);
        match = await chatQueue.dequeueAndMatch(userId, gender);
      } catch (_dbErr) {
        // Supabase not configured or migration missing — use in-memory queue
        if (process.env.NODE_ENV !== 'production') {
          console.debug('[chat:find-match] Supabase queue unavailable — using in-memory fallback');
        }
        memEnqueue(userId, gender, socket.id);
        match = memMatch(userId, gender);
      }

      if (!match) {
        console.debug(`[Chat] ${userId} entered queue — waiting for partner`);
        socket.emit('chat:waiting');
        return;
      }

      const { roomId, peerUserId, peerSocketId } = match;
      console.log(`[Chat] Match created — room: ${roomId} | user: ${userId} | peer: ${peerUserId}`);

      userRoomMap.set(userId,     { roomId });
      userRoomMap.set(peerUserId, { roomId });

      socket.join(roomId);
      const peerSocket = io.sockets.sockets.get(peerSocketId);
      if (peerSocket) peerSocket.join(roomId);

      // Caller is the initiator — sends the offer via simple-peer
      socket.emit('chat:matched', { roomId, initiator: true, peerId: peerUserId });

      if (peerSocket) {
        peerSocket.emit('chat:matched', { roomId, initiator: false, peerId: userId });
      } else {
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
      memDequeue(socket.uid);
      await chatQueue.dequeueUser(socket.uid).catch(() => {});
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

      memDequeue(userId);
      await chatQueue.dequeueUser(userId).catch(() => {});
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
  // Live thumbnail relay (host → live-list browsers)
  // Video streaming is handled by LiveKit — only thumbnails go through Socket.IO
  // -----------------------------------------------------------------------

  // Host registers their socket so thumbnail auth works.
  socket.on('live:host-register', ({ liveId } = {}) => {
    if (!liveId || socket.isGuest) return;
    liveHostMap.set(liveId, socket.id);
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[LiveKit] Host ${socket.uid} registered socket for live ${liveId}`);
    }
  });

  // Relay periodic canvas snapshots from host → live-list cards.
  socket.on('live:thumbnail-update', ({ liveId, thumbnail } = {}) => {
    if (!liveId || !thumbnail || typeof thumbnail !== 'string') return;
    if (liveHostMap.get(liveId) !== socket.id) return; // only registered host may push
    io.emit('live:thumbnail-update', { liveId, thumbnail });
  });

  socket.on('disconnect', async () => {
    console.log('Socket disconnected:', socket.id);

    const userId = socket.uid;
    userSocketMap.delete(userId);
    // Clean up any live host registration
    for (const [lid, sid] of liveHostMap) {
      if (sid === socket.id) { liveHostMap.delete(lid); break; }
    }

    // Broadcast updated viewer count for every live room this socket was in.
    // Socket.IO removes the socket from all rooms BEFORE firing 'disconnect',
    // so roomViewerCount() already reflects the departure.
    const liveRooms = socketLiveRooms.get(socket.id);
    if (liveRooms) {
      for (const liveId of liveRooms) {
        if (!socket.isGuest) {
          liveCtrl.leaveLive(liveId, userId).catch(() => {});
        }
        const viewersCount = roomViewerCount(liveId);
        io.to(liveId).emit('update-viewers', { viewersCount });
      }
      socketLiveRooms.delete(socket.id);
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
    memDequeue(userId);
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
