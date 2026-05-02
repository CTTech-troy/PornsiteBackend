/**
 * chatQueue.controller.js
 *
 * Supabase-backed functions for the random video-chat matching queue.
 * All DB operations are atomic RPCs defined in 20250414_chat_queue.sql.
 *
 * Resilience: if the migration has not been applied to the production
 * database the functions degrade gracefully — a one-time warning is logged
 * and all subsequent calls are silently skipped until the migration runs.
 */

import { supabase, isConfigured } from '../config/supabase.js';

// ---------------------------------------------------------------------------
// Schema availability guard
// null  = not yet confirmed either way
// true  = migration applied, tables/functions exist
// false = migration missing — skip DB calls and suppress repeated warnings
// ---------------------------------------------------------------------------
let _schemaAvailable = null;

/** PostgreSQL / PostgREST error codes that indicate a missing schema object. */
const SCHEMA_MISSING_CODES = new Set([
  '42P01',   // undefined_table
  '42883',   // undefined_function
  'PGRST202', // PostgREST: function not found in schema cache
  'PGRST116', // PostgREST: relation not found
]);

/**
 * Returns true when an error means the table / RPC does not exist yet
 * (i.e. the migration has not been applied).
 */
function _isSchemaError(err) {
  if (!err) return false;
  if (SCHEMA_MISSING_CODES.has(err.code)) return true;
  const msg = (err.message || '').toLowerCase();
  return (
    msg.includes('does not exist') ||
    msg.includes('could not find the function') ||
    msg.includes('undefined_table') ||
    msg.includes('undefined_function')
  );
}

/**
 * Log the one-time "migration missing" warning and silence future calls.
 */
function _markSchemaUnavailable(context) {
  if (_schemaAvailable === false) return; // already logged
  _schemaAvailable = false;
  console.warn(
    `[chatQueue] ⚠️  Schema not ready (triggered by: ${context}).\n` +
    `   The chat_queue table and its RPCs are missing from the database.\n` +
    `   Apply the migration once in the Supabase SQL Editor:\n` +
    `     backend/supabase/migrations/20250414_chat_queue.sql\n` +
    `   All chat-queue operations will be silently skipped until then.`
  );
}

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
  if (_schemaAvailable === false) return; // migration not applied

  const { error } = await supabase.rpc('enqueue_user', {
    p_user_id:   userId,
    p_gender:    gender ?? 'any',
    p_socket_id: socketId,
  });

  if (error) {
    if (_isSchemaError(error)) {
      _markSchemaUnavailable('enqueueUser');
      return;
    }
    throw error;
  }

  _schemaAvailable = true;
}

/**
 * Remove a user from the waiting queue (e.g. on disconnect or explicit cancel).
 * @param {string} userId
 */
export async function dequeueUser(userId) {
  if (!isConfigured()) return;
  if (_schemaAvailable === false) return; // migration not applied

  const { error } = await supabase
    .from('chat_queue')
    .delete()
    .eq('user_id', userId);

  if (error) {
    if (_isSchemaError(error)) {
      _markSchemaUnavailable('dequeueUser');
      return;
    }
    console.error('[chatQueue] dequeueUser error:', error.message);
  }
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
  if (_schemaAvailable === false) return null; // migration not applied

  const { data, error } = await supabase.rpc('dequeue_and_match', {
    p_user_id: userId,
    p_gender:  gender ?? 'any',
  });

  if (error) {
    if (_isSchemaError(error)) {
      _markSchemaUnavailable('dequeueAndMatch');
      return null;
    }
    throw error;
  }

  _schemaAvailable = true;

  if (!data || data.length === 0) return null;
  const row = data[0];
  if (!row?.room_id) return null;

  return {
    roomId:       row.room_id,
    peerUserId:   row.peer_user_id,
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
  if (_schemaAvailable === false) return; // migration not applied

  const { error } = await supabase.rpc('end_chat_room', {
    p_room_id: roomId,
  });

  if (error) {
    if (_isSchemaError(error)) {
      _markSchemaUnavailable('endChatRoom');
      return;
    }
    console.error('[chatQueue] endChatRoom error:', error.message);
  }
}

/**
 * Remove stale queue entries older than `secondsOld` seconds.
 *
 * This function is called on a 30-second interval from index.js.
 * If the migration has not been applied it logs a one-time warning and
 * returns silently on every subsequent call — it will NEVER throw.
 */
export async function cleanupStaleQueue(secondsOld = 30) {
  if (!isConfigured()) return;
  if (_schemaAvailable === false) return; // silently skip — migration not applied

  const { error } = await supabase.rpc('cleanup_stale_queue', {
    p_seconds_old: secondsOld,
  });

  if (error) {
    if (_isSchemaError(error)) {
      _markSchemaUnavailable('cleanupStaleQueue');
      return; // no re-throw — this is a background job
    }
    // Throttle noisy network errors: log at most once per 5 minutes
    const now = Date.now();
    const isNetworkErr = /fetch failed|ECONNREFUSED|ENOTFOUND|AbortError|timeout/i.test(error.message || '');
    if (!isNetworkErr || !cleanupStaleQueue._lastWarnTs || now - cleanupStaleQueue._lastWarnTs > 5 * 60 * 1000) {
      cleanupStaleQueue._lastWarnTs = now;
      console.warn('[chatQueue] cleanupStaleQueue unexpected error:', error.message);
    }
  } else {
    _schemaAvailable = true;
  }
}
