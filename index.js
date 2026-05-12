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
import creatorsMainApplicationRouter from './src/router/creatorsMainApplication.route.js';
import { renderVideoSharePreview } from './src/controller/sharePreview.controller.js';

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

app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));

console.log(`Starting server in ${process.env.NODE_ENV || 'development'} mode`);

app.get('/', (req, res) => {
  res.send(`API running on port ${PORT}`);
});

app.get('/api/health/services', async (req, res) => {
  try {
    const { firebase, supabase } = await pingServices();
    res.json({ firebase, supabase });
  } catch (err) { res.status(500).json({ error: err?.message || String(err) }); }
});

app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/admin/finance', financeRouter);
app.use('/api/admin/content', adminContentRouter);
app.use('/api/admin/moderation', adminModerationRouter);
app.use('/api/admin/system', adminSystemRouter);
app.get('/api/videos/stream/:id', (req, res) => streamCtrl.getStreamUrl(req, res));
// Videos proxy routes
app.use('/api/videos', videosRouter);
app.use('/api/pornhub', pornhubRouter);
app.use('/api/live', liveRouter);
app.use('/api/gifts', giftRouter);
app.use('/api/users', usersRouter);
app.use('/api/creators', creatorsRouter);
app.use('/api/contentRemoval', contentRemovalRouter);
app.use('/api/payments', paymentRouter);
app.use('/api/tokens', tokensRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/earnings', earningsRouter);
app.use('/api/studio', creatorStudioRouter);
app.use('/api/ads', adsRouter);
app.use('/api/memberships', publicMembershipsRouter);
app.use('/api/admin/memberships', adminMembershipsRouter);
// Creators Main Application
app.use('/api/creators-main-application', creatorsMainApplicationRouter);

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

io.on('connection', (socket) => {
  socket.on('join-live', ({ liveId }) => socket.join(liveId));
  socket.on('leave-live', ({ liveId }) => socket.leave(liveId));
  // ... more events
});

server.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  await ensureBuckets().catch(() => {});
  syncCacheToSupabase().catch(() => {});
  syncRtdbToSupabase().catch(() => {});
});
