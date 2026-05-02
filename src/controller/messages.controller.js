/**
 * Messaging — Supabase primary.
 * Conversations stored in public.conversations; messages in public.messages.
 */
import { supabase } from '../config/supabase.js';

const MAX_MESSAGE_LEN = 1000;

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

export async function sendMessageToCreator(req, res) {
  try {
    const senderId    = req.uid;
    const creatorId   = String(req.params.creatorId || '').trim();
    const messageText = normalizeMessageText(req.body?.messageText);

    if (!senderId)                         return res.status(401).json({ success: false, message: 'Authentication required' });
    if (!creatorId)                        return res.status(400).json({ success: false, message: 'creatorId is required' });
    if (String(senderId) === creatorId)    return res.status(400).json({ success: false, message: 'You cannot message yourself' });
    if (!messageText)                      return res.status(400).json({ success: false, message: 'Message cannot be empty' });
    if (!supabase)                         return res.status(503).json({ success: false, message: 'Messaging storage unavailable' });

    const conversationId  = conversationIdFor(senderId, creatorId);
    const now             = new Date().toISOString();
    const participants    = buildParticipants(senderId, creatorId);

    // Upsert conversation (preserve original created_at on conflict)
    const { error: convErr } = await supabase
      .from('conversations')
      .upsert([{
        id:                     conversationId,
        participant_ids:        participants,
        creator_id:             creatorId,
        last_message_text:      messageText.slice(0, 120),
        last_message_at:        now,
        last_message_sender_id: String(senderId),
        updated_at:             now,
      }], { onConflict: 'id', ignoreDuplicates: false });
    if (convErr) throw convErr;

    const { data: msg, error: msgErr } = await supabase
      .from('messages')
      .insert([{
        conversation_id: conversationId,
        sender_id:       String(senderId),
        receiver_id:     creatorId,
        creator_id:      creatorId,
        message_text:    messageText,
        read:            false,
      }])
      .select()
      .single();
    if (msgErr) throw msgErr;

    const message = {
      messageId:       msg.id,
      conversationId,
      senderId:        msg.sender_id,
      receiverId:      msg.receiver_id,
      creatorId:       msg.creator_id,
      messageText:     msg.message_text,
      read:            msg.read,
      createdAt:       new Date(msg.created_at).getTime(),
      updatedAt:       new Date(msg.updated_at).getTime(),
    };

    return res.status(201).json({ success: true, data: message, conversation: { conversationId, participantIds: participants } });
  } catch (err) {
    console.error('messages.sendMessageToCreator error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed to send message' });
  }
}

export async function listMyConversations(req, res) {
  try {
    const uid = req.uid;
    if (!uid)     return res.status(401).json({ success: false, message: 'Authentication required' });
    if (!supabase) return res.status(503).json({ success: false, message: 'Messaging storage unavailable' });

    const { data, error } = await supabase
      .from('conversations')
      .select('*')
      .contains('participant_ids', [String(uid)])
      .order('updated_at', { ascending: false });
    if (error) throw error;

    const list = (data || []).map((c) => ({
      conversationId:        c.id,
      participantIds:        c.participant_ids,
      creatorId:             c.creator_id,
      lastMessageText:       c.last_message_text || '',
      lastMessageAt:         c.last_message_at ? new Date(c.last_message_at).getTime() : 0,
      lastMessageSenderId:   c.last_message_sender_id || '',
      createdAt:             new Date(c.created_at).getTime(),
      updatedAt:             new Date(c.updated_at).getTime(),
    }));

    return res.json({ success: true, data: list });
  } catch (err) {
    console.error('messages.listMyConversations error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed to fetch conversations' });
  }
}

export async function getConversationMessages(req, res) {
  try {
    const uid            = req.uid;
    const conversationId = String(req.params.conversationId || '').trim();
    if (!uid)             return res.status(401).json({ success: false, message: 'Authentication required' });
    if (!conversationId)  return res.status(400).json({ success: false, message: 'conversationId is required' });
    if (!supabase)        return res.status(503).json({ success: false, message: 'Messaging storage unavailable' });

    const { data: conv, error: convErr } = await supabase
      .from('conversations')
      .select('*')
      .eq('id', conversationId)
      .maybeSingle();
    if (convErr) throw convErr;
    if (!conv) return res.status(404).json({ success: false, message: 'Conversation not found' });
    if (!Array.isArray(conv.participant_ids) || !conv.participant_ids.map(String).includes(String(uid))) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const { data: msgs, error: msgsErr } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });
    if (msgsErr) throw msgsErr;

    const messages = (msgs || []).map((m) => ({
      messageId:   m.id,
      conversationId,
      senderId:    m.sender_id,
      receiverId:  m.receiver_id,
      creatorId:   m.creator_id,
      messageText: m.message_text,
      read:        m.read,
      createdAt:   new Date(m.created_at).getTime(),
      updatedAt:   new Date(m.updated_at).getTime(),
    }));

    return res.json({ success: true, data: messages, conversation: { conversationId, participantIds: conv.participant_ids } });
  } catch (err) {
    console.error('messages.getConversationMessages error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed to fetch messages' });
  }
}

export async function markConversationRead(req, res) {
  try {
    const uid            = req.uid;
    const conversationId = String(req.params.conversationId || '').trim();
    if (!uid)             return res.status(401).json({ success: false, message: 'Authentication required' });
    if (!conversationId)  return res.status(400).json({ success: false, message: 'conversationId is required' });
    if (!supabase)        return res.status(503).json({ success: false, message: 'Messaging storage unavailable' });

    const { data: conv } = await supabase
      .from('conversations')
      .select('participant_ids')
      .eq('id', conversationId)
      .maybeSingle();
    if (!conv) return res.status(404).json({ success: false, message: 'Conversation not found' });
    if (!Array.isArray(conv.participant_ids) || !conv.participant_ids.map(String).includes(String(uid))) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    await supabase
      .from('messages')
      .update({ read: true, updated_at: new Date().toISOString() })
      .eq('conversation_id', conversationId)
      .eq('receiver_id', String(uid))
      .eq('read', false);

    return res.json({ success: true });
  } catch (err) {
    console.error('messages.markConversationRead error', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed to mark as read' });
  }
}
