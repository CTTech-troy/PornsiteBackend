/**
 * chatQueue.controller.js
 *
 * Supabase-backed functions for the random video-chat matching queue.
 * All DB operations are atomic RPCs defined in 20250414_chat_queue.sql.
 */

import { supabase, isConfigured } from '../config/supabase.js';

// ---------------------------------------------------------------------------
// Queue operations
// ---------------------------------------------------------------------------

/**
 * Add (or refresh) a user in the waiting queue.
 * @param {string} userId
 * @param {string} gender   'male' | 'female' | 'any'
 * @param {string} socketId Current socket.id
 */
export async function enqueueUser(userId, gender, socketId) {
  if (!isConfigured()) throw new Error('Supabase not configured');

  const { error } = await supabase.rpc('enqueue_user', {
    p_user_id:   userId,
    p_gender:    gender ?? 'any',
    p_socket_id: socketId,
  });

  if (error) throw error;
}

/**
 * Remove a user from the waiting queue (e.g. on disconnect or explicit cancel).
 * @param {string} userId
 */
export async function dequeueUser(userId) {
  if (!isConfigured()) return; // No-op if not configured

  const { error } = await supabase
    .from('chat_queue')
    .delete()
    .eq('user_id', userId);

  if (error) console.error('[chatQueue] dequeueUser error:', error.message);
}

/**
 * Atomically find a partner and create a room.
 * Returns { roomId, peerUserId, peerSocketId } if matched, or null if no partner.
 *
 * @param {string} userId
 * @param {string} gender
 * @returns {Promise<{roomId: string, peerUserId: string, peerSocketId: string} | null>}
 */
export async function dequeueAndMatch(userId, gender) {
  if (!isConfigured()) throw new Error('Supabase not configured');

  const { data, error } = await supabase.rpc('dequeue_and_match', {
    p_user_id: userId,
    p_gender:  gender ?? 'any',
  });

  if (error) throw error;
  if (!data || data.length === 0) return null;

  const row = data[0];
  if (!row?.room_id) return null;

  return {
    roomId:      row.room_id,
    peerUserId:  row.peer_user_id,
    peerSocketId: row.peer_socket_id,
  };
}

// ---------------------------------------------------------------------------
// Room operations
// ---------------------------------------------------------------------------

/**
 * Mark a room as ended (idempotent).
 * @param {string} roomId UUID
 */
export async function endChatRoom(roomId) {
  if (!isConfigured() || !roomId) return;

  const { error } = await supabase.rpc('end_chat_room', {
    p_room_id: roomId,
  });

  if (error) console.error('[chatQueue] endChatRoom error:', error.message);
}

/**
 * Remove stale queue entries older than `secondsOld` seconds.
 * Intended for periodic cleanup (call every ~30 s from a setInterval).
 */
export async function cleanupStaleQueue(secondsOld = 30) {
  if (!isConfigured()) return;

  const { error } = await supabase.rpc('cleanup_stale_queue', {
    p_seconds_old: secondsOld,
  });

  if (error) console.warn('[chatQueue] cleanupStaleQueue error:', error.message);
}
