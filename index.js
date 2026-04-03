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
import { ensureBuckets } from './src/config/supabase.js';
import { syncCacheToSupabase } from './src/config/live-cache.js';
import { syncRtdbToSupabase } from './src/config/dbFallback.js';
import { pingServices } from './src/utils/servicePing.js';
import { getAuthMetricsSnapshot } from './src/utils/authMetrics.js';

dotenv.config();

const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);
app.use(compression());
app.use(cors());
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

app.get('/api/health/auth-metrics', (req, res) => {
  if (process.env.AUTH_METRICS !== '1' && process.env.AUTH_METRICS !== 'true') {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json(getAuthMetricsSnapshot());
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
      origin: '*',
      methods: ['GET', 'POST']
    }
  });

  io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);

  socket.on('join-live', async ({ liveId, userId }) => {
    try {
      await socket.join(liveId);
      const v = await liveCtrl.joinLive(liveId, userId);
      const live = await liveCtrl.getLive(liveId);
      io.to(liveId).emit('update-viewers', { viewersCount: live?.viewers_count || 0 });
    } catch (err) {
      console.error('join-live error', err && err.message ? err.message : err);
      socket.emit('error', { message: String(err) });
    }
  });

  socket.on('leave-live', async ({ liveId, userId }) => {
    try {
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

  socket.on('comment-live', async ({ liveId, userId, message }) => {
    try {
      const comment = await liveCtrl.commentLive(liveId, userId, message);
      io.to(liveId).emit('new-comment', comment);
    } catch (err) {
      console.error('comment-live error', err && err.message ? err.message : err);
    }
  });

  socket.on('gift-live', async ({ liveId, senderId, giftType, quantity }) => {
    try {
      const giftDef = giftCtrl.getGift(giftType);
      if (!giftDef) {
        socket.emit('error', { message: 'Unknown gift type' });
        return;
      }
      const qty = Math.max(1, Number(quantity) || 1);
      const amount = +(giftDef.price * qty).toFixed(2);
      const gift = await liveCtrl.sendGift(liveId, senderId, giftType, amount);
      const live = await liveCtrl.getLive(liveId);
      io.to(liveId).emit('new-gift', {
        gift: { ...giftDef, quantity: qty, amount, record: gift },
        totalGiftsAmount: live?.total_gifts_amount || 0
      });
    } catch (err) {
      console.error('gift-live error', err && err.message ? err.message : err);
      socket.emit('error', { message: String(err?.message || err) });
    }
  });

  socket.on('end-live', async ({ liveId }) => {
    try {
      const payout = await liveCtrl.endLive(liveId);
      io.to(liveId).emit('live-ended', payout);
      // optionally disconnect room sockets
      const sockets = await io.in(liveId).fetchSockets();
      sockets.forEach(s => s.leave(liveId));
    } catch (err) {
      console.error('end-live error', err && err.message ? err.message : err);
    }
  });

  socket.on('pause-live', async ({ liveId }) => {
    try {
      await liveCtrl.pauseLive(liveId);
      io.to(liveId).emit('live-paused', { liveId });
    } catch (err) {
      console.error('pause-live error', err && err.message ? err.message : err);
    }
  });

  socket.on('resume-live', async ({ liveId }) => {
    try {
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

server.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  await checkConnections();
  ensureBuckets().then(() => {}).catch(() => {});
  syncCacheToSupabase().catch(() => {});
  syncRtdbToSupabase().catch(() => {});
  setInterval(() => {
    syncCacheToSupabase().catch(() => {});
    syncRtdbToSupabase().catch(() => {});
  }, 60 * 1000);
});
