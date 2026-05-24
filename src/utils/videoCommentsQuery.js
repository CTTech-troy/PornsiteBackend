import { supabase } from '../config/supabase.js';

let authorNameColumnAvailable = null;

function isMissingAuthorNameColumn(error) {
  return error?.code === '42703' && /author_name/i.test(String(error?.message || ''));
}

async function hasAuthorNameColumn() {
  if (!supabase) return false;
  if (authorNameColumnAvailable !== null) return authorNameColumnAvailable;
  const { error } = await supabase.from('tiktok_video_comments').select('author_name').limit(0);
  if (!error) {
    authorNameColumnAvailable = true;
    return true;
  }
  if (isMissingAuthorNameColumn(error)) {
    authorNameColumnAvailable = false;
    return false;
  }
  throw error;
}

export function mapCommentRow(c) {
  return {
    commentId: c.id,
    userId: c.user_id,
    authorName: c.author_name || 'Member',
    text: c.comment,
    createdAt: new Date(c.created_at).getTime(),
  };
}

export async function fetchVideoComments(videoId) {
  if (!supabase) return [];
  const withAuthor = await hasAuthorNameColumn();
  const select = withAuthor
    ? 'id, user_id, author_name, comment, created_at'
    : 'id, user_id, comment, created_at';

  const { data, error } = await supabase
    .from('tiktok_video_comments')
    .select(select)
    .eq('video_id', videoId)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return (data || []).map(mapCommentRow);
}

export async function insertVideoComment({ videoId, userId, text, authorName = 'Member' }) {
  if (!supabase) throw new Error('Video interactions temporarily unavailable.');

  const baseRow = { video_id: videoId, user_id: userId, comment: text };
  const withAuthor = await hasAuthorNameColumn();

  if (withAuthor) {
    const { data, error } = await supabase
      .from('tiktok_video_comments')
      .insert([{ ...baseRow, author_name: authorName }])
      .select('id, created_at, author_name')
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from('tiktok_video_comments')
    .insert([baseRow])
    .select('id, created_at')
    .single();
  if (error) throw error;
  return { ...data, author_name: null };
}
