import './src/config/env.js';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import { randomUUID } from 'crypto';
import authRouter from './src/router/auth.route.js';
import keepAliveRouter from './src/router/keepAlive.route.js';
import apiMonitoringWorkflowRouter from './src/router/apiMonitoringWorkflow.route.js';
import payoutWorkflowRouter from './src/router/payoutWorkflow.route.js';
import aiModerationWorkflowRouter from './src/router/aiModerationWorkflow.route.js';
import monetizationWorkflowRouter from './src/router/monetizationWorkflow.route.js';
import videosRouter from './src/router/videos.route.js';
import postsRouter from './src/router/posts.route.js';
import * as streamCtrl from './src/controller/stream.controller.js';
import liveRouter from './src/router/live.route.js';
import giftRouter from './src/router/gift.route.js';
import usersRouter from './src/router/users.route.js';
import creatorsRouter from './src/router/creators.route.js';
import pornhubRouter from './src/router/pornhubRoutes.js';
import contentRemovalRouter from './src/router/ContentRemoval.route.js';
import paymentRouter from './src/router/payment.route.js';
import tokensRouter  from './src/router/tokens.route.js';
import coinsRouter from './src/router/coins.route.js';
import messagesRouter from './src/router/messages.route.js';
import earningsRouter from './src/router/earnings.route.js';
import adminRouter from './src/router/admin.route.js';
import adsRouter from './src/router/ads.route.js';
import { publicMembershipsRouter, adminMembershipsRouter } from './src/router/memberships.route.js';
import financeRouter from './src/router/finance.route.js';
import creatorStudioRouter from './src/router/creatorStudio.route.js';
import adminContentRouter from './src/router/adminContent.route.js';
import adminModerationRouter from './src/router/adminModeration.route.js';
import adminSystemRouter from './src/router/adminSystem.route.js';
import adminCoinsRouter from './src/router/adminCoins.route.js';
import { getPublicSettings } from './src/controller/adminSystem.controller.js';
import * as liveCtrl from './src/controller/live.controller.js';
import { creditLiveEarnings } from './src/controller/earnings.controller.js';
import * as giftCtrl from './src/controller/gift.controller.js';
import * as walletsystem from './src/controller/walletsystem.controller.js';
import * as chatQueue from './src/controller/chatQueue.controller.js';
import * as randomChatBilling from './src/services/randomChatBilling.service.js';
import { supabase, ensureBuckets } from './src/config/supabase.js';
import { syncCacheToSupabase } from './src/config/live-cache.js';
import { syncRtdbToSupabase } from './src/config/dbFallback.js';
import { printFirebaseStartupSummary } from './src/config/firebase.js';
import { pingServices } from './src/utils/servicePing.js';
import { pingPaymentService, STARTUP_HEALTH_TIMEOUT_MS } from './src/services/paymentServiceClient.js';
import { resolveUidFromBearerToken } from './src/utils/sessionToken.js';
import { getAuthMetricsSnapshot } from './src/utils/authMetrics.js';
import creatorsMainApplicationRouter from './src/router/creatorsMainApplication.route.js';
import { renderVideoSharePreview } from './src/controller/sharePreview.controller.js';
import { preloadExternalFeedConfig } from './src/services/externalFeedConfig.service.js';
import { generalApiRateLimiter } from './src/middleware/apiRateLimit.js';
import { apiMonitoringMiddleware } from './src/middleware/apiMonitoring.js';
import { getRedisHealth, pingRedis } from './src/config/redis.js';
import { getQstashStatus } from './src/config/qstash.js';
import { resolveAdminSessionFromToken } from './src/middleware/adminAuth.js';
import { getApiOverview } from './src/services/apiMonitoring.service.js';
import {
  endAiSession,
  ensureAiSession,
  getAiModerationOverview,
  recordModerationSignal,
} from './src/services/aiModeration.service.js';

const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
 
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(compression());

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5176', 'http://localhost:3000',
  'https://xstreamvideos.netlify.app', 'https://pornsite-two.vercel.app', 'https://xstreamvideos.site', 'https://adminxstramvideos.netlify.app'
];

function parseAllowedOrigins(rawOrigins) {
  const envList = typeof rawOrigins === 'string' && rawOrigins.trim() ? rawOrigins.split(',').map((s) => s.trim()).filter(Boolean) : [];
  return Array.from(new Set([...DEFAULT_ALLOWED_ORIGINS, ...envList]));
}

const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.CORS_ORIGINS);
const allowedOriginsSet = new Set(ALLOWED_ORIGINS);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOriginsSet.has(origin)) return callback(null, true);
    callback(new Error(`Not allowed by CORS for origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  optionsSuccessStatus: 204,
}));

// QStash signs the exact request body. Capture keep-alive requests as raw bytes
// before the global JSON parser so verification works for dashboard-created
// schedules as well as the SDK-created JSON schedule.
app.use('/api/keepalive', express.raw({ type: '*/*', limit: '16kb' }));
app.use('/api/internal/qstash/monitoring', express.raw({ type: '*/*', limit: '64kb' }));
app.use('/api/internal/qstash/payouts', express.raw({ type: '*/*', limit: '64kb' }));
app.use('/api/internal/qstash/ai-moderation', express.raw({ type: '*/*', limit: '128kb' }));
app.use('/api/internal/qstash/monetization', express.raw({ type: '*/*', limit: '64kb' }));
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
app.use(apiMonitoringMiddleware);

const apiMetrics = {
  startedAt: new Date().toISOString(),
  total: 0,
  success: 0,
  failure: 0,
  totalLatencyMs: 0,
  routes: new Map(),
  snapshot() {
    const routes = Array.from(this.routes.entries()).map(([path, stats]) => ({
      path,
      count: stats.count,
      success: stats.success,
      failure: stats.failure,
      avgLatencyMs: stats.count ? Math.round(stats.totalLatencyMs / stats.count) : 0,
      maxLatencyMs: stats.maxLatencyMs,
      lastStatus: stats.lastStatus,
      lastSeenAt: stats.lastSeenAt,
    })).sort((a, b) => b.avgLatencyMs - a.avgLatencyMs).slice(0, 25);
    return {
      startedAt: this.startedAt,
      total: this.total,
      success: this.success,
      failure: this.failure,
      avgLatencyMs: this.total ? Math.round(this.totalLatencyMs / this.total) : 0,
      routes,
    };
  },
};

app.set('apiMetrics', apiMetrics);

app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) return next();
  const started = Date.now();
  res.on('finish', () => {
    const latency = Date.now() - started;
    const key = `${req.method} ${String(req.originalUrl || req.url || '').split('?')[0]}`;
    const stats = apiMetrics.routes.get(key) || {
      count: 0,
      success: 0,
      failure: 0,
      totalLatencyMs: 0,
      maxLatencyMs: 0,
      lastStatus: 0,
      lastSeenAt: null,
    };
    stats.count += 1;
    stats.totalLatencyMs += latency;
    stats.maxLatencyMs = Math.max(stats.maxLatencyMs, latency);
    stats.lastStatus = res.statusCode;
    stats.lastSeenAt = new Date().toISOString();
    if (res.statusCode >= 500) stats.failure += 1;
    else stats.success += 1;
    apiMetrics.total += 1;
    apiMetrics.totalLatencyMs += latency;
    if (res.statusCode >= 500) apiMetrics.failure += 1;
    else apiMetrics.success += 1;
    apiMetrics.routes.set(key, stats);
  });
  next();
});

console.log(`Starting server in ${process.env.NODE_ENV || 'development'} mode`);

app.get('/', (req, res) => {
  res.send(`API running on port ${PORT}`);
});

app.get('/api/health/services', async (req, res) => {
  try {
    const { firebase, supabase } = await pingServices();
    res.json({ firebase, supabase, redis: getRedisHealth(), qstash: getQstashStatus() });
  } catch (err) { res.status(500).json({ error: err?.message || String(err) }); }
});

app.get('/api/health/redis', async (req, res) => {
  const redis = await pingRedis();
  res.status(redis.configured && !redis.connected ? 503 : 200).json({ redis });
});

app.get('/api/config/public', getPublicSettings);

app.use('/api/keepalive', keepAliveRouter);
app.use('/api/internal/qstash/monitoring', apiMonitoringWorkflowRouter);
app.use('/api/internal/qstash/payouts', payoutWorkflowRouter);
app.use('/api/internal/qstash/ai-moderation', aiModerationWorkflowRouter);
app.use('/api/internal/qstash/monetization', monetizationWorkflowRouter);

// Shared Upstash Redis-backed limit for all API routes. Auth routes below add
// stricter endpoint-specific limits on top of this baseline.
app.use('/api', generalApiRateLimiter);

app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/admin/finance', financeRouter);
app.use('/api/admin/content', adminContentRouter);
app.use('/api/admin/moderation', adminModerationRouter);
app.use('/api/admin/system', adminSystemRouter);
app.use('/api/admin/coins', adminCoinsRouter);
app.use('/api/admin/creators-main-application', creatorsMainApplicationRouter);
app.get('/api/videos/stream/:id', (req, res) => streamCtrl.getStreamUrl(req, res));
// Videos proxy routes
app.use('/api/videos', videosRouter);
app.use('/api/posts', postsRouter);
app.use('/api/pornhub', pornhubRouter);
app.use('/api/live', liveRouter);
app.use('/api/gifts', giftRouter);
app.use('/api/users', usersRouter);
app.use('/api/creators', creatorsRouter);
app.use('/api/creator', creatorsRouter);
app.use('/api/contentRemoval', contentRemovalRouter);
app.use('/api/content-removal', contentRemovalRouter);
app.use('/api/payments', paymentRouter);
app.use('/api/tokens', tokensRouter);
app.use('/api/coins', coinsRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/earnings', earningsRouter);
app.use('/api/studio', creatorStudioRouter);
app.use('/api/ads', adsRouter);
app.use('/api/memberships', publicMembershipsRouter);
app.use('/api/admin/memberships', adminMembershipsRouter);
// Creators Main Application
app.use('/api/creators-main-application', creatorsMainApplicationRouter);

app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    message: `API route not found: ${req.method} ${req.originalUrl}`,
  });
});

const PORT = process.env.PORT || 5043;
import http from 'http';
const server = http.createServer(app);
import { Server } from 'socket.io';
const io = new Server(server, { cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'], credentials: true } });

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
    if (token) {
      const uid = await resolveUidFromBearerToken(token);
      if (uid) { socket.uid = uid; socket.isGuest = false; return next(); }
    }
    socket.uid = `guest:${socket.id}`; socket.isGuest = true; next();
  } catch (err) { socket.uid = `guest:${socket.id}`; socket.isGuest = true; next(); }
});

app.set('io', io);

const VALID_CHAT_GENDERS = new Set(['male', 'female', 'any']);
const chatQueueEntries = new Map(); // userId -> { userId, socketId, gender, preference, joinedAt }
const chatRooms = new Map(); // roomId -> { roomId, a, b, createdAt }
const userActiveChatRooms = new Map(); // userId -> roomId
const CHAT_READY_TIMEOUT_MS = 45_000;

function normalizeChatGender(value) {
  const v = String(value || '').trim().toLowerCase();
  return VALID_CHAT_GENDERS.has(v) ? v : 'any';
}

function preferenceAllows(preference, peerGender) {
  return preference === 'any' || preference === peerGender;
}

function usersAreCompatible(a, b) {
  return (
    a.userId !== b.userId &&
    preferenceAllows(a.preference, b.gender) &&
    preferenceAllows(b.preference, a.gender)
  );
}

function publicChatUser(entry) {
  return {
    userId: entry.userId,
    gender: entry.gender,
    preference: entry.preference,
  };
}

function chatBillingPayload(access = {}) {
  return {
    cost: randomChatBilling.RANDOM_CHAT_BILLING_COST,
    intervalMs: randomChatBilling.RANDOM_CHAT_BILLING_INTERVAL_MS,
    lowBalanceThreshold: randomChatBilling.RANDOM_CHAT_LOW_BALANCE,
    balance: Number(access.balance || 0),
    membershipActive: access.membershipActive === true,
    plan: access.plan || 'basic',
    planStatus: access.planStatus || 'basic',
  };
}

function emitChatBalance(socket, access = {}) {
  socket.emit('chat:balance', chatBillingPayload(access));
}

function emitChatPaywall(socket, access = {}, message = 'You have run out of coins. Purchase a membership to continue using Random Chat.') {
  socket.emit('chat:paywall', {
    ...chatBillingPayload(access),
    reason: access.reason || 'INSUFFICIENT_COINS',
    message,
  });
}

async function getSocketChatAccess(socket) {
  const access = await randomChatBilling.getRandomChatAccess(socket.uid);
  emitChatBalance(socket, access);
  if (!access.allowed) {
    emitChatPaywall(socket, access);
    return null;
  }
  return access;
}

function chatPeerUserId(room, userId) {
  if (!room) return null;
  if (room.a.userId === userId) return room.b.userId;
  if (room.b.userId === userId) return room.a.userId;
  return null;
}

function chatRoomSocket(entry) {
  return entry?.socketId ? io.sockets.sockets.get(entry.socketId) : null;
}

function clearChatRoomTimers(room) {
  if (!room) return;
  clearTimeout(room.readyTimeout);
  clearTimeout(room.billingTimer);
  room.readyTimeout = null;
  room.billingTimer = null;
}

async function finalizeChatUsage(room, userEntry, reason = 'ended', status = 'ended') {
  const billing = room?.billingByUser?.get(userEntry.userId);
  if (!billing) return;
  await randomChatBilling.finalizeUsageRecord({
    id: billing.usageId,
    roomId: room.roomId,
    userId: userEntry.userId,
    startedAt: room.createdAt,
    connectedAt: room.connectedAt,
    endedAt: Date.now(),
    coinsSpent: billing.coinsSpent || 0,
    billingEvents: billing.events || [],
    endReason: reason,
    status,
  }).catch(() => {});
}

function emitLowBalance(socket, access = {}) {
  const balance = Number(access.balance || 0);
  if (access.membershipActive || balance > randomChatBilling.RANDOM_CHAT_LOW_BALANCE) return;
  socket.emit('chat:low-balance', {
    ...chatBillingPayload(access),
    message: `You are running low on coins (${balance.toLocaleString()} left).`,
  });
}

function parseCsvEnv(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function getRtcIceServers() {
  const stunUrls = parseCsvEnv('WEBRTC_STUN_URLS');
  const turnUrls = parseCsvEnv('WEBRTC_TURN_URLS').concat(parseCsvEnv('TURN_URLS'));
  const iceServers = [
    { urls: stunUrls.length ? stunUrls : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];
  if (turnUrls.length) {
    iceServers.push({
      urls: turnUrls,
      username: process.env.WEBRTC_TURN_USERNAME || process.env.TURN_USERNAME || '',
      credential: process.env.WEBRTC_TURN_CREDENTIAL || process.env.TURN_CREDENTIAL || '',
    });
  }
  return iceServers;
}

function isValidSessionDescription(desc, expectedType) {
  return (
    desc &&
    desc.type === expectedType &&
    typeof desc.sdp === 'string' &&
    desc.sdp.length > 0 &&
    desc.sdp.length < 200_000
  );
}

function isValidIceCandidate(candidate) {
  return (
    candidate &&
    typeof candidate.candidate === 'string' &&
    candidate.candidate.length < 5000
  );
}

function checkSocketRate(socket, key, limit, windowMs) {
  const now = Date.now();
  const store = socket.data.rateLimits || {};
  const hits = (store[key] || []).filter((ts) => now - ts < windowMs);
  if (hits.length >= limit) {
    store[key] = hits;
    socket.data.rateLimits = store;
    return false;
  }
  hits.push(now);
  store[key] = hits;
  socket.data.rateLimits = store;
  return true;
}

function removeQueuedUser(userId) {
  if (!userId) return;
  chatQueueEntries.delete(userId);
  chatQueue.dequeueUser(userId).catch(() => {});
}

function leaveSocketRooms(socket) {
  const roomIds = Array.from(socket.data.chatRoomIds || []);
  for (const roomId of roomIds) {
    endChatRoom(roomId, socket.uid, { notifySelf: false });
  }
  socket.data.chatRoomIds = new Set();
}

async function findCompatiblePeer(requester) {
  const candidates = Array.from(chatQueueEntries.values())
    .filter((candidate) => usersAreCompatible(requester, candidate))
    .sort((a, b) => a.joinedAt - b.joinedAt);

  for (const candidate of candidates) {
    const peerSocket = io.sockets.sockets.get(candidate.socketId);
    if (!peerSocket || !peerSocket.connected) {
      chatQueueEntries.delete(candidate.userId);
      continue;
    }

    const peerAccess = await getSocketChatAccess(peerSocket).catch(() => null);
    if (!peerAccess) {
      chatQueueEntries.delete(candidate.userId);
      chatQueue.dequeueUser(candidate.userId).catch(() => {});
      continue;
    }

    return { peer: candidate, peerAccess };
  }
  return null;
}

async function createChatRoom(requester, peer, requesterAccess, peerAccess) {
  const requesterSocket = io.sockets.sockets.get(requester.socketId);
  const peerSocket = io.sockets.sockets.get(peer.socketId);
  if (!requesterSocket || !peerSocket) return null;

  if (userActiveChatRooms.has(requester.userId)) {
    endChatRoom(userActiveChatRooms.get(requester.userId), requester.userId, { notifySelf: true, reason: 'new-session' });
  }
  if (userActiveChatRooms.has(peer.userId)) {
    endChatRoom(userActiveChatRooms.get(peer.userId), peer.userId, { notifySelf: true, reason: 'new-session' });
  }

  const roomId = randomUUID();
  const room = {
    roomId,
    a: requester,
    b: peer,
    createdAt: Date.now(),
    connectedAt: null,
    ready: new Set(),
    billingByUser: new Map([
      [requester.userId, { access: requesterAccess, intervalIndex: 0, coinsSpent: 0, events: [], usageId: null }],
      [peer.userId, { access: peerAccess, intervalIndex: 0, coinsSpent: 0, events: [], usageId: null }],
    ]),
    billingInFlight: false,
    billingClosed: false,
    readyTimeout: null,
    billingTimer: null,
  };
  chatRooms.set(roomId, room);
  userActiveChatRooms.set(requester.userId, roomId);
  userActiveChatRooms.set(peer.userId, roomId);
  chatQueueEntries.delete(requester.userId);
  chatQueueEntries.delete(peer.userId);

  requesterSocket.join(roomId);
  peerSocket.join(roomId);
  requesterSocket.data.chatRoomIds = requesterSocket.data.chatRoomIds || new Set();
  peerSocket.data.chatRoomIds = peerSocket.data.chatRoomIds || new Set();
  requesterSocket.data.chatRoomIds.add(roomId);
  peerSocket.data.chatRoomIds.add(roomId);
  ensureAiSession({
    sessionId: roomId,
    sessionType: 'ivi',
    title: 'Random 1-on-1 session',
    metadata: {
      participants: [requester.userId, peer.userId],
      hidden: true,
      role: 'system_ai',
    },
    io,
  }).catch((error) => console.warn('[ai-moderation] IVI session init failed:', error?.message || error));
  emitChatBalance(requesterSocket, requesterAccess);
  emitChatBalance(peerSocket, peerAccess);
  emitLowBalance(requesterSocket, requesterAccess);
  emitLowBalance(peerSocket, peerAccess);

  const iceServers = getRtcIceServers();
  requesterSocket.emit('chat:matched', {
    roomId,
    initiator: true,
    peer: publicChatUser(peer),
    iceServers,
    billing: chatBillingPayload(requesterAccess),
  });
  peerSocket.emit('chat:matched', {
    roomId,
    initiator: false,
    peer: publicChatUser(requester),
    iceServers,
    billing: chatBillingPayload(peerAccess),
  });

  for (const [userId, billing] of room.billingByUser.entries()) {
    const peerUserId = chatPeerUserId(room, userId);
    randomChatBilling.createUsageRecord({
      roomId,
      userId,
      peerUserId,
      startedAt: room.createdAt,
      membershipBypass: billing.access?.membershipActive === true,
      startingBalance: billing.access?.balance || 0,
    }).then((usageId) => {
      const activeRoom = chatRooms.get(roomId);
      activeRoom?.billingByUser?.get(userId) && (activeRoom.billingByUser.get(userId).usageId = usageId);
    }).catch(() => {});
  }

  room.readyTimeout = setTimeout(() => {
    endChatRoom(roomId, null, { notifySelf: true, reason: 'setup-timeout', status: 'failed' });
  }, CHAT_READY_TIMEOUT_MS);
  room.readyTimeout.unref?.();

  return room;
}

function getRoomForSocket(socket, roomId) {
  const room = chatRooms.get(String(roomId || ''));
  if (!room) return null;
  return room.a.userId === socket.uid || room.b.userId === socket.uid ? room : null;
}

function emitToRoomPeer(socket, roomId, event, payload = {}) {
  const room = getRoomForSocket(socket, roomId);
  if (!room) {
    socket.emit('chat:error', { message: 'Chat session is no longer active.' });
    return false;
  }
  socket.to(room.roomId).emit(event, {
    ...payload,
    roomId: room.roomId,
    fromId: socket.uid,
  });
  return true;
}

function scheduleChatBilling(room) {
  if (!room || room.billingClosed || !chatRooms.has(room.roomId)) return;
  clearTimeout(room.billingTimer);
  room.billingTimer = setTimeout(() => {
    chargeChatRoom(room.roomId).catch((err) => {
      console.error('[chat] billing cycle failed:', err?.message || err);
      const activeRoom = chatRooms.get(room.roomId);
      if (activeRoom) scheduleChatBilling(activeRoom);
    });
  }, randomChatBilling.RANDOM_CHAT_BILLING_INTERVAL_MS);
  room.billingTimer.unref?.();
}

async function chargeChatRoom(roomId) {
  const room = chatRooms.get(String(roomId || ''));
  if (!room || room.billingClosed || !room.connectedAt || room.billingInFlight) return;
  room.billingInFlight = true;

  try {
    for (const user of [room.a, room.b]) {
      const userSocket = chatRoomSocket(user);
      if (!userSocket?.connected) {
        endChatRoom(room.roomId, user.userId, { notifySelf: true, reason: 'socket-disconnected' });
        return;
      }

      const billing = room.billingByUser.get(user.userId);
      billing.intervalIndex += 1;
      let result;
      try {
        result = await randomChatBilling.chargeRandomChatInterval({
          userId: user.userId,
          roomId: room.roomId,
          peerUserId: chatPeerUserId(room, user.userId),
          intervalIndex: billing.intervalIndex,
        });
      } catch (err) {
        err.userId = user.userId;
        throw err;
      }
      const event = {
        ts: new Date().toISOString(),
        intervalIndex: billing.intervalIndex,
        charged: result.charged === true,
        amount: Number(result.amount || 0),
        balance: Number(result.balance || 0),
        membershipActive: result.membershipActive === true,
      };
      billing.events.push(event);
      billing.coinsSpent += event.amount;
      billing.access = { ...billing.access, ...result, balance: event.balance };
      emitChatBalance(userSocket, billing.access);
      emitLowBalance(userSocket, billing.access);
    }
  } catch (err) {
    const exhausted = err?.code === 'INSUFFICIENT_COINS';
    const user = [room.a, room.b].find((entry) => entry.userId === err?.userId) || room.a;
    const userSocket = chatRoomSocket(user);
    if (userSocket) emitChatPaywall(userSocket, { balance: err?.balance || 0, reason: err?.code || 'BILLING_FAILED' });
    endChatRoom(room.roomId, user.userId, {
      notifySelf: true,
      reason: exhausted ? 'coins-exhausted' : 'billing-failed',
      status: exhausted ? 'exhausted' : 'failed',
    });
    return;
  } finally {
    const activeRoom = chatRooms.get(String(roomId || ''));
    if (activeRoom) activeRoom.billingInFlight = false;
  }

  const activeRoom = chatRooms.get(String(roomId || ''));
  if (activeRoom) scheduleChatBilling(activeRoom);
}

function maybeStartChatBilling(room) {
  if (!room || room.connectedAt) return;
  if (!room.ready.has(room.a.userId) || !room.ready.has(room.b.userId)) return;
  room.connectedAt = Date.now();
  clearTimeout(room.readyTimeout);
  room.readyTimeout = null;
  io.to(room.roomId).emit('chat:connected', {
    roomId: room.roomId,
    connectedAt: room.connectedAt,
    billing: chatBillingPayload(room.billingByUser.get(room.a.userId)?.access || {}),
  });
  recordModerationSignal({
    sessionId: room.roomId,
    sessionType: 'ivi',
    eventType: 'session_connected',
    source: 'socket',
    contentType: 'behavior',
    metadata: {
      participants: [room.a.userId, room.b.userId],
      connectedAt: room.connectedAt,
    },
    queueAi: false,
    io,
  }).catch(() => {});
  scheduleChatBilling(room);
}

function endChatRoom(roomId, endedBy, { notifySelf = true, reason = 'ended', status = 'ended' } = {}) {
  const room = chatRooms.get(String(roomId || ''));
  if (!room) return;
  room.billingClosed = true;
  clearChatRoomTimers(room);
  chatRooms.delete(room.roomId);
  chatQueue.endChatRoom(room.roomId).catch(() => {});
  endAiSession({
    sessionId: room.roomId,
    status: status === 'failed' ? 'failed' : 'ended',
    metadata: { reason, endedBy },
    io,
  }).catch((error) => console.warn('[ai-moderation] IVI session end failed:', error?.message || error));

  for (const user of [room.a, room.b]) {
    const peerSocket = io.sockets.sockets.get(user.socketId);
    userActiveChatRooms.delete(user.userId);
    finalizeChatUsage(room, user, reason, status).catch(() => {});
    if (peerSocket) {
      peerSocket.leave(room.roomId);
      if (peerSocket.data.chatRoomIds) peerSocket.data.chatRoomIds.delete(room.roomId);
      if (notifySelf || user.userId !== endedBy) {
        const eventName = endedBy && user.userId !== endedBy ? 'chat:peer-left' : 'chat:ended';
        peerSocket.emit(eventName, {
          roomId: room.roomId,
          reason,
        });
      }
    }
  }
}

function cleanupInMemoryChatQueue() {
  const cutoff = Date.now() - 45_000;
  for (const entry of chatQueueEntries.values()) {
    const peerSocket = io.sockets.sockets.get(entry.socketId);
    if (!peerSocket || !peerSocket.connected || entry.joinedAt < cutoff) {
      chatQueueEntries.delete(entry.userId);
      peerSocket?.emit('chat:ended', { reason: 'queue-timeout' });
    }
  }
}

const liveRooms = new Map(); // liveId -> { viewers: Map<viewerKey, Set<socketId>>, hosts, mutedUsers, likes, giftsTotal, comments }

function normalizeLiveId(value) {
  const id = String(value || '').trim();
  if (!id || id.length > 160) return '';
  return id;
}

function cleanLiveText(value, max = 500) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function getLiveRoomState(liveId) {
  const id = normalizeLiveId(liveId);
  if (!id) return null;
  if (!liveRooms.has(id)) {
    liveRooms.set(id, {
      viewers: new Map(),
      hosts: new Set(),
      mutedUsers: new Map(),
      likes: 0,
      giftsTotal: 0,
      comments: [],
      lastSeen: Date.now(),
    });
  }
  return liveRooms.get(id);
}

function getSocketLivePresence(socket) {
  socket.data.livePresence = socket.data.livePresence || new Map();
  return socket.data.livePresence;
}

function addLiveViewer(liveId, viewerKey, socketId) {
  const state = getLiveRoomState(liveId);
  if (!state || !viewerKey || !socketId) return 0;
  const sockets = state.viewers.get(viewerKey) || new Set();
  sockets.add(socketId);
  state.viewers.set(viewerKey, sockets);
  state.lastSeen = Date.now();
  return state.viewers.size;
}

function removeLiveViewer(liveId, viewerKey, socketId) {
  const state = getLiveRoomState(liveId);
  if (!state || !viewerKey || !socketId) return 0;
  const sockets = state.viewers.get(viewerKey);
  if (!sockets) return state.viewers.size;
  sockets.delete(socketId);
  if (sockets.size === 0) state.viewers.delete(viewerKey);
  state.lastSeen = Date.now();
  return state.viewers.size;
}

function emitLiveViewerCount(liveId) {
  const state = getLiveRoomState(liveId);
  const viewersCount = state ? state.viewers.size : 0;
  io.to(liveId).emit('update-viewers', { liveId, viewersCount });
  return viewersCount;
}

async function hydrateLiveSocketState(liveId) {
  const state = getLiveRoomState(liveId);
  if (!state) return null;
  try {
    const live = await liveCtrl.getLive(liveId);
    if (live) {
      state.likes = Number(live.total_likes || live.totalLikes || state.likes || 0);
      state.giftsTotal = Number(live.total_gifts_amount || live.totalGiftsAmount || state.giftsTotal || 0);
    }
    return live;
  } catch {
    return null;
  }
}

async function socketCanModerateLive(socket, liveId) {
  if (!socket?.uid || socket.isGuest) return false;
  const live = await liveCtrl.getLive(liveId).catch(() => null);
  return Boolean(live?.host_id && String(live.host_id) === String(socket.uid));
}

function emitLiveError(socket, message) {
  socket.emit('live:error', { message });
}

async function joinLiveSocket(socket, payload = {}) {
  const liveId = normalizeLiveId(payload.liveId || payload.sessionId || payload.id);
  if (!liveId) return;

  const requestedUserId = cleanLiveText(payload.userId || socket.uid, 140) || socket.uid;
  const viewerKey = socket.isGuest ? `guest:${socket.id}` : String(socket.uid || requestedUserId);
  const state = getLiveRoomState(liveId);
  socket.join(liveId);

  let isHost = false;
  try {
    const joined = await liveCtrl.joinLive(liveId, requestedUserId);
    isHost = joined?.role === 'host';
    const live = await hydrateLiveSocketState(liveId);
    if (live?.host_id && String(live.host_id) === String(requestedUserId)) isHost = true;
  } catch (err) {
    console.warn('[live] join failed:', err?.message || err);
  }

  if (isHost) {
    state.hosts.add(socket.id);
  } else {
    addLiveViewer(liveId, viewerKey, socket.id);
  }

  getSocketLivePresence(socket).set(liveId, {
    viewerKey,
    userId: requestedUserId,
    counted: !isHost,
  });

  const viewersCount = emitLiveViewerCount(liveId);
  socket.emit('live:joined', {
    liveId,
    role: isHost ? 'host' : 'viewer',
    viewersCount,
    totalLikes: state.likes,
    totalGiftsAmount: state.giftsTotal,
  });
}

async function leaveLiveSocket(socket, payload = {}) {
  const liveId = normalizeLiveId(payload.liveId || payload.sessionId || payload.id);
  if (!liveId) return;

  const presence = getSocketLivePresence(socket);
  const entry = presence.get(liveId);
  const viewerKey = entry?.viewerKey || (socket.isGuest ? `guest:${socket.id}` : String(socket.uid || payload.userId || socket.id));
  if (entry?.counted) removeLiveViewer(liveId, viewerKey, socket.id);

  const state = getLiveRoomState(liveId);
  state?.hosts.delete(socket.id);
  presence.delete(liveId);
  socket.leave(liveId);

  if (entry?.counted) {
    liveCtrl.leaveLive(liveId, entry.userId || viewerKey).catch((err) => {
      console.warn('[live] leave failed:', err?.message || err);
    });
  }
  emitLiveViewerCount(liveId);
}

function leaveAllLiveRooms(socket) {
  const presence = getSocketLivePresence(socket);
  const entries = Array.from(presence.entries());
  for (const [liveId, entry] of entries) {
    if (entry?.counted) {
      removeLiveViewer(liveId, entry.viewerKey, socket.id);
      liveCtrl.leaveLive(liveId, entry.userId || entry.viewerKey).catch(() => {});
    }
    getLiveRoomState(liveId)?.hosts.delete(socket.id);
    emitLiveViewerCount(liveId);
    socket.leave(liveId);
  }
  presence.clear();
}

io.on('connection', (socket) => {
  if (!socket.isGuest && socket.uid) {
    socket.join(`user:${socket.uid}`);
  }

  socket.on('admin:api-monitoring:subscribe', async (payload = {}) => {
    try {
      const headerToken = socket.handshake.headers?.authorization?.replace('Bearer ', '');
      const token = payload.token || socket.handshake.auth?.adminToken || headerToken;
      const admin = await resolveAdminSessionFromToken(token);
      if (!admin) {
        socket.emit('admin:api-monitoring:error', { message: 'Admin token required.' });
        return;
      }

      socket.admin = admin;
      socket.join('admin:api-monitoring');
      const snapshot = await getApiOverview({ range: payload.range || '1h' });
      socket.emit('admin:api-monitoring:update', snapshot);
    } catch {
      socket.emit('admin:api-monitoring:error', { message: 'Could not subscribe to API monitoring.' });
    }
  });

  socket.on('admin:api-monitoring:unsubscribe', () => {
    socket.leave('admin:api-monitoring');
  });

  socket.on('admin:ai-moderation:subscribe', async (payload = {}) => {
    try {
      const headerToken = socket.handshake.headers?.authorization?.replace('Bearer ', '');
      const token = payload.token || socket.handshake.auth?.adminToken || headerToken;
      const admin = await resolveAdminSessionFromToken(token);
      const permissions = Array.isArray(admin?.permissions) ? admin.permissions : [];
      const role = String(admin?.role || '').toLowerCase();
      const allowed = admin?.is_super_admin ||
        ['admin', 'moderator', 'operations', 'support'].includes(role) ||
        permissions.includes('ai_moderator') ||
        permissions.includes('/ai-moderator');
      if (!allowed) {
        socket.emit('admin:ai-moderation:error', { message: 'AI moderation admin token required.' });
        return;
      }

      socket.admin = admin;
      socket.join('admin:ai-moderation');
      socket.emit('admin:ai-moderation:update', await getAiModerationOverview());
    } catch {
      socket.emit('admin:ai-moderation:error', { message: 'Could not subscribe to AI moderation.' });
    }
  });

  socket.on('admin:ai-moderation:unsubscribe', () => {
    socket.leave('admin:ai-moderation');
  });

  socket.on('join-live', (payload = {}) => {
    joinLiveSocket(socket, payload).catch((err) => {
      console.error('[live] join socket error:', err?.message || err);
      emitLiveError(socket, 'Could not join this live stream.');
    });
  });

  socket.on('leave-live', (payload = {}) => {
    leaveLiveSocket(socket, payload).catch(() => {});
  });

  socket.on('live:host-register', async (payload = {}) => {
    const liveId = normalizeLiveId(payload.liveId);
    if (!liveId) return;
    if (!(await socketCanModerateLive(socket, liveId))) return emitLiveError(socket, 'Only the host can manage this stream.');
    const state = getLiveRoomState(liveId);
    state.hosts.add(socket.id);
    const entry = getSocketLivePresence(socket).get(liveId);
    if (entry?.counted) {
      removeLiveViewer(liveId, entry.viewerKey, socket.id);
      entry.counted = false;
      getSocketLivePresence(socket).set(liveId, entry);
      emitLiveViewerCount(liveId);
    }
    socket.join(liveId);
    ensureAiSession({
      sessionId: liveId,
      sessionType: 'livestream',
      creatorId: socket.uid,
      title: 'Livestream',
      metadata: { hidden: true, role: 'system_ai', hostSocket: socket.id },
      io,
    }).catch((error) => console.warn('[ai-moderation] live session init failed:', error?.message || error));
  });

  socket.on('comment-live', async (payload = {}) => {
    const liveId = normalizeLiveId(payload.liveId);
    const message = cleanLiveText(payload.message || payload.text, 500);
    if (!liveId || !message) return;
    if (socket.isGuest) return emitLiveError(socket, 'Sign in to comment on live streams.');
    if (!checkSocketRate(socket, 'live:comment', 35, 60_000)) return emitLiveError(socket, 'You are commenting too quickly.');

    const state = getLiveRoomState(liveId);
    const userKey = String(socket.uid);
    const mutedUntil = state.mutedUsers.get(userKey);
    if (mutedUntil && mutedUntil > Date.now()) return emitLiveError(socket, 'You are muted in this stream.');
    if (mutedUntil) state.mutedUsers.delete(userKey);

    const authorName = cleanLiveText(payload.authorName || payload.author_name || 'Viewer', 80) || 'Viewer';
    let record = null;
    try {
      record = await liveCtrl.commentLive(liveId, socket.uid, message);
    } catch (err) {
      console.warn('[live] comment persistence failed:', err?.message || err);
    }
    const comment = {
      id: record?.id || randomUUID(),
      liveId,
      userId: socket.uid,
      user_id: socket.uid,
      authorName,
      message,
      createdAt: record?.created_at || new Date().toISOString(),
    };
    state.comments.push(comment);
    state.comments = state.comments.slice(-200);
    recordModerationSignal({
      sessionId: liveId,
      sessionType: 'livestream',
      eventType: 'live_comment',
      source: 'socket',
      userId: socket.uid,
      contentType: 'chat',
      contentId: comment.id,
      message,
      metadata: { authorName, liveId },
      io,
    }).catch(() => {});
    io.to(liveId).emit('new-comment', comment);
  });

  socket.on('like-live', async (payload = {}) => {
    const liveId = normalizeLiveId(payload.liveId);
    if (!liveId) return;
    if (socket.isGuest) return emitLiveError(socket, 'Sign in to like live streams.');
    if (!checkSocketRate(socket, 'live:like', 120, 60_000)) return;

    const state = getLiveRoomState(liveId);
    let nextLikes = state.likes + 1;
    try {
      const live = await liveCtrl.likeLive(liveId);
      nextLikes = Number(live?.total_likes ?? live?.totalLikes ?? nextLikes);
    } catch (err) {
      console.warn('[live] like persistence failed:', err?.message || err);
    }
    state.likes = nextLikes;
    io.to(liveId).emit('update-likes', { liveId, totalLikes: nextLikes });
    io.to(liveId).emit('new-reaction', {
      id: randomUUID(),
      liveId,
      userId: socket.uid,
      type: cleanLiveText(payload.type || 'heart', 40),
      createdAt: Date.now(),
    });
  });

  socket.on('gift-live', async (payload = {}) => {
    const liveId = normalizeLiveId(payload.liveId);
    if (!liveId) return;
    if (socket.isGuest) return emitLiveError(socket, 'Sign in to send gifts.');
    if (!checkSocketRate(socket, 'live:gift', 30, 60_000)) return emitLiveError(socket, 'You are sending gifts too quickly.');

    const giftType = cleanLiveText(payload.giftType || payload.gift?.id || payload.id || 'gift', 80);
    const giftName = cleanLiveText(payload.name || payload.giftName || payload.gift?.name || giftType, 80);
    const amount = Math.max(0, Number(payload.amount ?? payload.price ?? payload.gift?.price ?? 0));
    const senderName = cleanLiveText(payload.senderName || payload.authorName || 'Viewer', 80) || 'Viewer';
    const emoji = cleanLiveText(payload.emoji || payload.gift?.emoji || '', 20);
    const state = getLiveRoomState(liveId);

    try {
      if (payload.tokenPaid) {
        await liveCtrl.sendGift(liveId, socket.uid, giftType, amount);
      } else {
        await giftCtrl.processGift({ liveId, senderId: socket.uid, giftType, quantity: Number(payload.quantity) || 1 });
      }
    } catch (err) {
      console.warn('[live] gift persistence failed:', err?.message || err);
    }

    state.giftsTotal = +(Number(state.giftsTotal || 0) + amount).toFixed(2);
    recordModerationSignal({
      sessionId: liveId,
      sessionType: 'livestream',
      eventType: 'gift_activity',
      source: 'socket',
      userId: socket.uid,
      contentType: 'behavior',
      metadata: {
        giftType,
        amount,
        riskScore: amount >= 500 ? 55 : 5,
        labels: amount >= 500 ? { signals: ['large_live_gift'] } : {},
      },
      queueAi: false,
      io,
    }).catch(() => {});
    io.to(liveId).emit('new-gift', {
      id: randomUUID(),
      liveId,
      senderId: socket.uid,
      senderName,
      giftType,
      giftName,
      name: giftName,
      emoji,
      amount,
      totalGiftsAmount: state.giftsTotal,
      createdAt: new Date().toISOString(),
    });
  });

  socket.on('pause-live', async (payload = {}) => {
    const liveId = normalizeLiveId(payload.liveId);
    if (!liveId) return;
    if (!(await socketCanModerateLive(socket, liveId))) return emitLiveError(socket, 'Only the host can pause this stream.');
    await liveCtrl.pauseLive(liveId).catch((err) => console.warn('[live] pause failed:', err?.message || err));
    io.to(liveId).emit('live-paused', { liveId });
    io.emit('live_paused', { liveId });
  });

  socket.on('resume-live', async (payload = {}) => {
    const liveId = normalizeLiveId(payload.liveId);
    if (!liveId) return;
    if (!(await socketCanModerateLive(socket, liveId))) return emitLiveError(socket, 'Only the host can resume this stream.');
    await liveCtrl.resumeLive(liveId).catch((err) => console.warn('[live] resume failed:', err?.message || err));
    io.to(liveId).emit('live-resumed', { liveId });
    io.emit('live_resumed', { liveId });
  });

  socket.on('end-live', async (payload = {}) => {
    const liveId = normalizeLiveId(payload.liveId);
    if (!liveId) return;
    if (!(await socketCanModerateLive(socket, liveId))) return emitLiveError(socket, 'Only the host can end this stream.');
    const payout = await liveCtrl.endLive(liveId, { requesterId: socket.uid }).catch((err) => {
      console.warn('[live] end failed:', err?.message || err);
      return null;
    });
    io.to(liveId).emit('live-ended', { liveId, payout });
    io.emit('live_ended', { liveId, payout });
    endAiSession({ sessionId: liveId, status: 'ended', metadata: { reason: 'host_ended', endedBy: socket.uid }, io }).catch(() => {});
    liveRooms.delete(liveId);
  });

  socket.on('live:thumbnail-update', async (payload = {}) => {
    const liveId = normalizeLiveId(payload.liveId);
    const thumbnail = String(payload.thumbnail || '');
    if (!liveId || !thumbnail || thumbnail.length > 350_000) return;
    if (!checkSocketRate(socket, 'live:thumbnail', 12, 60_000)) return;
    if (!(await socketCanModerateLive(socket, liveId))) return;
    recordModerationSignal({
      sessionId: liveId,
      sessionType: 'livestream',
      eventType: 'livestream_frame',
      source: 'socket',
      userId: socket.uid,
      contentType: 'frame',
      contentRef: `thumbnail:${Date.now()}`,
      metadata: {
        liveId,
        frameBytes: thumbnail.length,
        snapshotUrl: thumbnail.startsWith('data:') ? null : thumbnail.slice(0, 500),
      },
      io,
    }).catch(() => {});
    io.emit('live:thumbnail-update', { liveId, thumbnail });
  });

  socket.on('live:delete-comment', async (payload = {}) => {
    const liveId = normalizeLiveId(payload.liveId);
    const commentId = cleanLiveText(payload.commentId || payload.id, 120);
    if (!liveId || !commentId) return;
    if (!(await socketCanModerateLive(socket, liveId))) return emitLiveError(socket, 'Only the host can moderate this stream.');
    const state = getLiveRoomState(liveId);
    state.comments = state.comments.filter((comment) => String(comment.id) !== commentId);
    io.to(liveId).emit('live:comment-deleted', { liveId, commentId });
  });

  socket.on('live:mute-user', async (payload = {}) => {
    const liveId = normalizeLiveId(payload.liveId);
    const targetUserId = cleanLiveText(payload.userId || payload.user_id, 140);
    if (!liveId || !targetUserId) return;
    if (!(await socketCanModerateLive(socket, liveId))) return emitLiveError(socket, 'Only the host can moderate this stream.');
    const durationMs = Math.min(24 * 60 * 60 * 1000, Math.max(60_000, Number(payload.durationMs) || 10 * 60_000));
    getLiveRoomState(liveId).mutedUsers.set(targetUserId, Date.now() + durationMs);
    io.to(liveId).emit('live:user-muted', { liveId, userId: targetUserId, durationMs });
  });

  socket.on('live:report', (payload = {}) => {
    const liveId = normalizeLiveId(payload.liveId);
    const reason = cleanLiveText(payload.reason || 'reported', 250);
    console.warn('[live] report', {
      liveId,
      reporter: socket.uid,
      reason,
    });
    recordModerationSignal({
      sessionId: liveId,
      sessionType: 'livestream',
      eventType: 'user_report',
      source: 'socket',
      userId: socket.uid,
      contentType: 'behavior',
      message: reason,
      metadata: { riskScore: 70, reason },
      io,
    }).catch(() => {});
    socket.emit('live:report-received', { liveId });
  });

  socket.on('chat:find-match', async (payload = {}) => {
    try {
      if (socket.isGuest) {
        socket.emit('chat:error', { message: 'Please sign in to use random video chat.' });
        return;
      }
      if (!checkSocketRate(socket, 'chat:find-match', 12, 60_000)) {
        socket.emit('chat:error', { message: 'You are searching too quickly. Please wait a moment.' });
        return;
      }

      leaveSocketRooms(socket);
      removeQueuedUser(socket.uid);

      const requesterAccess = await getSocketChatAccess(socket);
      if (!requesterAccess) return;

      const ownGender = normalizeChatGender(payload.ownGender || payload.selfGender || payload.myGender || payload.genderIdentity);
      const preferredGender = normalizeChatGender(payload.preferredGender || payload.preference || payload.gender);
      const requester = {
        userId: socket.uid,
        socketId: socket.id,
        gender: ownGender,
        preference: preferredGender,
        joinedAt: Date.now(),
      };

      const match = await findCompatiblePeer(requester);
      if (match?.peer) {
        await createChatRoom(requester, match.peer, requesterAccess, match.peerAccess);
        return;
      }

      chatQueueEntries.set(requester.userId, requester);
      chatQueue.enqueueUser(requester.userId, requester.gender, socket.id).catch(() => {});
      socket.emit('chat:waiting', {
        gender: requester.gender,
        preference: requester.preference,
      });
    } catch (err) {
      console.error('[chat] find-match error:', err?.message || err);
      socket.emit('chat:error', { message: 'Could not start matchmaking. Please try again.' });
    }
  });

  socket.on('chat:webrtc-offer', ({ roomId, offer } = {}) => {
    if (!checkSocketRate(socket, 'chat:signal', 300, 60_000)) return;
    if (!isValidSessionDescription(offer, 'offer')) return;
    emitToRoomPeer(socket, roomId, 'chat:webrtc-offer', { offer });
  });

  socket.on('chat:webrtc-answer', ({ roomId, answer } = {}) => {
    if (!checkSocketRate(socket, 'chat:signal', 300, 60_000)) return;
    if (!isValidSessionDescription(answer, 'answer')) return;
    emitToRoomPeer(socket, roomId, 'chat:webrtc-answer', { answer });
  });

  socket.on('chat:ice-candidate', ({ roomId, candidate } = {}) => {
    if (!checkSocketRate(socket, 'chat:signal', 500, 60_000)) return;
    if (!isValidIceCandidate(candidate)) return;
    emitToRoomPeer(socket, roomId, 'chat:ice-candidate', { candidate });
  });

  socket.on('chat:ready', ({ roomId } = {}) => {
    const room = getRoomForSocket(socket, roomId);
    if (!room) return;
    room.ready.add(socket.uid);
    maybeStartChatBilling(room);
  });

  socket.on('chat:media-state', ({ roomId, muted, cameraOff } = {}) => {
    emitToRoomPeer(socket, roomId, 'chat:media-state', {
      muted: muted === true,
      cameraOff: cameraOff === true,
    });
  });

  socket.on('chat:message', ({ roomId, text } = {}) => {
    if (!checkSocketRate(socket, 'chat:message', 60, 60_000)) return;
    const trimmed = String(text || '').trim().slice(0, 500);
    if (!trimmed) return;
    const room = getRoomForSocket(socket, roomId);
    if (room) {
      recordModerationSignal({
        sessionId: room.roomId,
        sessionType: 'ivi',
        eventType: 'chat_message',
        source: 'socket',
        userId: socket.uid,
        peerUserId: chatPeerUserId(room, socket.uid),
        contentType: 'chat',
        message: trimmed,
        metadata: { roomId: room.roomId },
        io,
      }).catch(() => {});
    }
    emitToRoomPeer(socket, roomId, 'chat:message', {
      text: trimmed,
      ts: Date.now(),
    });
  });

  socket.on('chat:report', ({ roomId, reason } = {}) => {
    const cleanReason = String(reason || 'reported').trim().slice(0, 250);
    const room = getRoomForSocket(socket, roomId);
    if (!room) return;
    console.warn('[chat] report', {
      roomId: room.roomId,
      reporter: socket.uid,
      reason: cleanReason,
      peer: room.a.userId === socket.uid ? room.b.userId : room.a.userId,
    });
    recordModerationSignal({
      sessionId: room.roomId,
      sessionType: 'ivi',
      eventType: 'user_report',
      source: 'socket',
      userId: socket.uid,
      peerUserId: chatPeerUserId(room, socket.uid),
      contentType: 'behavior',
      message: cleanReason,
      metadata: { riskScore: 70, reason: cleanReason },
      io,
    }).catch(() => {});
    socket.emit('chat:report-received', { roomId: room.roomId });
  });

  socket.on('chat:next', ({ roomId } = {}) => {
    if (roomId) endChatRoom(roomId, socket.uid, { notifySelf: false, reason: 'next' });
    removeQueuedUser(socket.uid);
  });

  socket.on('chat:leave', ({ roomId } = {}) => {
    if (roomId) endChatRoom(roomId, socket.uid, { notifySelf: false, reason: 'left' });
    removeQueuedUser(socket.uid);
  });

  socket.on('disconnect', () => {
    leaveAllLiveRooms(socket);
    removeQueuedUser(socket.uid);
    leaveSocketRooms(socket);
  });
});

setInterval(() => {
  cleanupInMemoryChatQueue();
  chatQueue.cleanupStaleQueue(45).catch(() => {});
}, 30_000).unref?.();

server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`[server] Port ${PORT} is already in use.`);
    console.error('[server] Stop the existing backend process or start this server with a different PORT value.');
    console.error(`[server] Windows check: netstat -ano | findstr :${PORT}`);
    console.error('[server] Windows stop: taskkill /PID <PID> /F');
    process.exit(1);
  }

  console.error('[server] Failed to start:', err);
  process.exit(1);
});

server.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  await ensureBuckets().catch(() => {});
  preloadExternalFeedConfig().catch((err) => {
    console.warn('[externalFeed] config preload failed:', err?.message || err);
  });
  syncCacheToSupabase().catch(() => {});
  syncRtdbToSupabase().catch(() => {});
});
