import express from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import dotenv from 'dotenv';
import authRouter from './src/router/auth.route.js';
import videosRouter from './src/router/videos.route.js';
import liveRouter from './src/router/live.route.js';
import giftRouter from './src/router/gift.route.js';
import usersRouter from './src/router/users.route.js';
import creatorsRouter from './src/router/creators.route.js';
import postsRouter from './src/router/posts.route.js';
import pornhubRouter from './src/router/pornhubRoutes.js';
import * as liveCtrl from './src/controller/live.controller.js';
import * as giftCtrl from './src/controller/gift.controller.js';
import * as walletsystem from './src/controller/walletsystem.controller.js';
import { supabase, ensureBuckets } from './src/config/supabase.js';
import { syncCacheToSupabase } from './src/config/live-cache.js';
import { syncRtdbToSupabase } from './src/config/dbFallback.js';
import { pingServices } from './src/utils/servicePing.js';
import { resolveUidFromBearerToken } from './src/utils/sessionToken.js';

dotenv.config();

const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));

// Secure HTTP headers
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

app.use(compression());

// SEC-02: Restrict CORS to allowed origins (comma-separated in env, fallback to localhost dev)
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3000')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    // Allow requests with no origin (server-to-server, curl, mobile apps)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

console.log(`Starting server in ${process.env.NODE_ENV || 'development'} mode`);

app.get('/', (req, res) => {
  res.send('API running on port 5000');
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

// Auth routes
app.use('/api/auth', authRouter);
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

const PORT = process.env.PORT || 5000;

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

  io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id, 'uid:', socket.uid);

  socket.on('join-live', async ({ liveId }) => {
    try {
      const userId = socket.uid; // authenticated — never trust client
      await socket.join(liveId);
      await liveCtrl.joinLive(liveId, userId);
      const live = await liveCtrl.getLive(liveId);
      io.to(liveId).emit('update-viewers', { viewersCount: live?.viewers_count || 0 });
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
      const live = await liveCtrl.getLive(liveId);
      io.to(liveId).emit('update-viewers', { viewersCount: live?.viewers_count || 0 });
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

  socket.on('comment-live', async ({ liveId, message }) => {
    try {
      const userId = socket.uid; // authenticated
      const comment = await liveCtrl.commentLive(liveId, userId, message);
      io.to(liveId).emit('new-comment', comment);
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
      // Only the host should be able to end their own live
      const live = await liveCtrl.getLive(liveId);
      if (live && live.host_id !== socket.uid) {
        socket.emit('error', { message: 'Only the host can end this live stream' });
        return;
      }
      const payout = await liveCtrl.endLive(liveId);
      io.to(liveId).emit('live-ended', payout);
      const sockets = await io.in(liveId).fetchSockets();
      sockets.forEach(s => s.leave(liveId));
    } catch (err) {
      console.error('end-live error', err && err.message ? err.message : err);
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

  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.id);
  });
  });
} catch (err) {
  console.warn('socket.io not available — running without real-time features:', err?.message || err);
  // provide a minimal no-op io object so code referencing io won't crash
  io = {
    to: () => ({ emit: () => {} }),
    in: () => ({ fetchSockets: async () => [] }),
    on: () => {}
  };
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
