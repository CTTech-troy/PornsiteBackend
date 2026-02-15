import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRouter from './src/router/auth.route.js';
import videosRouter from './src/router/videos.route.js';
import liveRouter from './src/router/live.route.js';
import * as liveCtrl from './src/controller/live.controller.js';
import { auth } from './src/config/firebase.js';
import { supabase } from './src/config/supabase.js';

dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

console.log(`Starting server in ${process.env.NODE_ENV || 'development'} mode`);

app.get('/', (req, res) => {
  res.send('API running on port 5000');
});

// Auth routes
app.use('/api/auth', authRouter);
// Videos proxy routes
app.use('/api/videos', videosRouter);
// Live routes
app.use('/api/live', liveRouter);

const PORT = process.env.PORT || 5000;

async function checkConnections() {
  // Firebase check
  try {
    // guard Firebase check with a short timeout to avoid long startup stalls
    const fbCheck = auth.listUsers(1);
    const fbRes = await Promise.race([
      fbCheck,
      new Promise((_, rej) => setTimeout(() => rej(new Error('Firebase check timed out')), 5000))
    ]);
    if (fbRes) console.log('✅ Firebase: connected (auth reachable)');
  } catch (err) {
    console.error('❌ Firebase: connection failed —', err && err.message ? err.message : err);
  }
  try {
    // Run a short supabase query and guard with timeout
    const supPromise = supabase.from('users').select('id').limit(1);
    const supRes = await Promise.race([
      supPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('Supabase check timed out')), 5000))
    ]);
    // supRes may be an object with error property
    if (supRes && !supRes.error) {
      console.log('✅ Supabase: connected (query executed)');
    } else if (supRes && supRes.error) {
      console.warn('⚠️ Supabase: query returned an error —', supRes.error.message || supRes.error);
    } else {
      console.warn('⚠️ Supabase: unexpected response from check', supRes);
    }
  } catch (err) {
    console.error('❌ Supabase: connection failed —', err && err.message ? err.message : err);
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
      origin: '*',
      methods: ['GET', 'POST']
    }
  });

  io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);
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

  socket.on('gift-live', async ({ liveId, senderId, giftType, amount }) => {
    try {
      const gift = await liveCtrl.sendGift(liveId, senderId, giftType, amount);
      const live = await liveCtrl.getLive(liveId);
      io.to(liveId).emit('new-gift', { gift, totalGiftsAmount: live?.total_gifts_amount || 0 });
    } catch (err) {
      console.error('gift-live error', err && err.message ? err.message : err);
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
});
