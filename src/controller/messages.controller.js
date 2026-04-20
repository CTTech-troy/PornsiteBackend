import crypto from 'crypto';
import { getFirebaseRtdb } from '../config/firebase.js';

const MAX_MESSAGE_LEN = 1000;

function rtdb() {
  return getFirebaseRtdb();
}

function conversationsRef() {
  const db = rtdb();
  return db ? db.ref('conversations') : null;
}

function messagesRef() {
  const db = rtdb();
  return db ? db.ref('conversation_messages') : null;
}

function normalizeMessageText(value) {
  return String(value || '').trim().slice(0, MAX_MESSAGE_LEN);
}

function buildParticipants(a, b) {
  return [String(a || '').trim(), String(b || '').trim()].filter(Boolean).sort();
}

function conversationIdFor(userId, creatorId) {
  const [a, b] = buildParticipants(userId, creatorId);
  return `${a}__${b}`;
}

async function requireConversationMembership(conversationId, uid) {
  const ref = conversationsRef();
  if (!ref) return { error: { status: 503, message: 'Messaging storage unavailable' } };
  const snap = await ref.child(conversationId).once('value');
  const conv = snap.val();
  if (!conv) return { error: { status: 404, message: 'Conversation not found' } };
  const participants = Array.isArray(conv.participantIds) ? conv.participantIds.map(String) : [];
  if (!participants.includes(String(uid))) {
    return { error: { status: 403, message: 'Forbidden' } };
  }
  return { conversation: conv };
}

export async function sendMessageToCreator(req, res) {
  try {
    const senderId = req.uid;
    const creatorId = String(req.params.creatorId || '').trim();
    const messageText = normalizeMessageText(req.body?.messageText);

    if (!senderId) return res.status(401).json({ success: false, message: 'Authentication required' });
    if (!creatorId) return res.status(400).json({ success: false, message: 'creatorId is required' });
    if (String(senderId) === creatorId) {
      return res.status(400).json({ success: false, message: 'You cannot message yourself' });
    }
    if (!messageText) return res.status(400).json({ success: false, message: 'Message cannot be empty' });

    const convRef = conversationsRef();
    const msgRef = messagesRef();
    if (!convRef || !msgRef) {
      return res.status(503).json({ success: false, message: 'Messaging storage unavailable' });
    }

    const conversationId = conversationIdFor(senderId, creatorId);
    const now = Date.now();
    const existingSnap = await convRef.child(conversationId).once('value');
    const existing = existingSnap.val() || {};

    const messageId = crypto.randomUUID();
    const message = {
      messageId,
      conversationId,
      senderId: String(senderId),
      receiverId: creatorId,
      creatorId,
      messageText,
      read: false,
      createdAt: now,
      updatedAt: now,
    };

    const participants = buildParticipants(senderId, creatorId);
    const conversation = {
      conversationId,
      participantIds: participants,
      creatorId,
      lastMessageText: messageText.slice(0, 120),
      lastMessageAt: now,
      lastMessageSenderId: String(senderId),
      createdAt: existing.createdAt || now,
      updatedAt: now,
    };

    await Promise.all([
      convRef.child(conversationId).set(conversation),
      msgRef.child(conversationId).child(messageId).set(message),
    ]);

    return res.status(201).json({ success: true, data: message, conversation });
  } catch (err) {
    console.error('messages.sendMessageToCreator error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed to send message' });
  }
}

export async function listMyConversations(req, res) {
  try {
    const uid = req.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });
    const ref = conversationsRef();
    if (!ref) return res.status(503).json({ success: false, message: 'Messaging storage unavailable' });

    const snap = await ref.once('value');
    const val = snap.val() || {};
    const list = Object.values(val)
      .filter((row) => Array.isArray(row?.participantIds) && row.participantIds.map(String).includes(String(uid)))
      .sort((a, b) => Number(b?.lastMessageAt || 0) - Number(a?.lastMessageAt || 0));

    return res.json({ success: true, data: list });
  } catch (err) {
    console.error('messages.listMyConversations error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed to fetch conversations' });
  }
}

export async function getConversationMessages(req, res) {
  try {
    const uid = req.uid;
    const conversationId = String(req.params.conversationId || '').trim();
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });
    if (!conversationId) return res.status(400).json({ success: false, message: 'conversationId is required' });

    const membership = await requireConversationMembership(conversationId, uid);
    if (membership.error) return res.status(membership.error.status).json({ success: false, message: membership.error.message });

    const ref = messagesRef();
    if (!ref) return res.status(503).json({ success: false, message: 'Messaging storage unavailable' });
    const snap = await ref.child(conversationId).once('value');
    const val = snap.val() || {};
    const messages = Object.values(val).sort((a, b) => Number(a?.createdAt || 0) - Number(b?.createdAt || 0));

    return res.json({ success: true, data: messages, conversation: membership.conversation });
  } catch (err) {
    console.error('messages.getConversationMessages error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed to fetch messages' });
  }
}

export async function markConversationRead(req, res) {
  try {
    const uid = req.uid;
    const conversationId = String(req.params.conversationId || '').trim();
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });
    if (!conversationId) return res.status(400).json({ success: false, message: 'conversationId is required' });

    const membership = await requireConversationMembership(conversationId, uid);
    if (membership.error) return res.status(membership.error.status).json({ success: false, message: membership.error.message });

    const ref = messagesRef();
    if (!ref) return res.status(503).json({ success: false, message: 'Messaging storage unavailable' });
    const snap = await ref.child(conversationId).once('value');
    const val = snap.val() || {};
    const updates = {};
    const now = Date.now();
    Object.entries(val).forEach(([id, msg]) => {
      if (msg && String(msg.receiverId) === String(uid) && msg.read !== true) {
        updates[`${id}/read`] = true;
        updates[`${id}/updatedAt`] = now;
      }
    });
    if (Object.keys(updates).length > 0) {
      await ref.child(conversationId).update(updates);
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('messages.markConversationRead error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed to mark as read' });
  }
}
