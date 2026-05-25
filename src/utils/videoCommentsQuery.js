import { supabase } from '../config/supabase.js';

let authorNameColumnAvailable = null;

function isMissingAuthorNameColumn(error) {
  return error?.code === '42703' && /author_name/i.test(String(error?.message || ''));
}

function isMissingCommentColumn(error) {
  return error?.code === '42703' || /column .* does not exist|schema cache/i.test(String(error?.message || ''));
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
  const deleted = c.deleted_at || c.status === 'deleted';
  return {
    commentId: c.id,
    userId: c.user_id,
    authorName: c.author_name || 'Member',
    text: deleted ? '' : c.comment,
    createdAt: new Date(c.created_at).getTime(),
    updatedAt: c.updated_at ? new Date(c.updated_at).getTime() : null,
    editedAt: c.edited_at ? new Date(c.edited_at).getTime() : null,
    parentCommentId: c.parent_comment_id || null,
    deleted: !!deleted,
    status: c.status || (deleted ? 'deleted' : 'visible'),
    moderationStatus: c.moderation_status || 'approved',
  };
}

export async function fetchVideoComments(videoId) {
  if (!supabase) return [];
  const fullSelect = [
    'id',
    'user_id',
    'author_name',
    'comment',
    'created_at',
    'updated_at',
    'edited_at',
    'parent_comment_id',
    'deleted_at',
    'status',
    'moderation_status',
  ].join(', ');

  let query = supabase
    .from('tiktok_video_comments')
    .select(fullSelect)
    .eq('video_id', videoId)
    .is('deleted_at', null)
    .eq('status', 'visible')
    .order('created_at', { ascending: true });

  let { data, error } = await query;

  if (error && isMissingCommentColumn(error)) {
    const withAuthor = await hasAuthorNameColumn();
    const select = withAuthor
      ? 'id, user_id, author_name, comment, created_at'
      : 'id, user_id, comment, created_at';

    const fallback = await supabase
      .from('tiktok_video_comments')
      .select(select)
      .eq('video_id', videoId)
      .order('created_at', { ascending: true });
    data = fallback.data;
    error = fallback.error;
  }

  if (error) throw error;
  return (data || []).map(mapCommentRow);
}

export async function insertVideoComment({ videoId, userId, text, authorName = 'Member', parentCommentId = null }) {
  if (!supabase) throw new Error('Video interactions temporarily unavailable.');

  const { data: rpcData, error: rpcError } = await supabase.rpc('add_video_comment', {
    p_video_id: videoId,
    p_user_id: userId,
    p_comment: text,
    p_author_name: authorName,
    p_parent_comment_id: parentCommentId || null,
  });

  if (!rpcError && rpcData) {
    return {
      id: rpcData?.comment?.commentId,
      created_at: rpcData?.comment?.createdAt ? new Date(Number(rpcData.comment.createdAt)).toISOString() : new Date().toISOString(),
      author_name: rpcData?.comment?.authorName || authorName,
      text: rpcData?.comment?.text || text,
      parent_comment_id: rpcData?.comment?.parentCommentId || null,
      total_comments: Number(rpcData?.total_comments ?? 0),
      duplicate: rpcData?.duplicate === true,
      rpc: rpcData,
    };
  }

  if (rpcError && !/Could not find the function|function .* does not exist|schema cache|PGRST202|42883/i.test(String(rpcError?.message || rpcError?.code || ''))) {
    throw rpcError;
  }

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

export async function updateVideoComment({ videoId, commentId, userId, text }) {
  if (!supabase) throw new Error('Video interactions temporarily unavailable.');
  const { data, error } = await supabase.rpc('update_video_comment', {
    p_video_id: videoId,
    p_comment_id: commentId,
    p_user_id: userId,
    p_comment: text,
  });
  if (error) throw error;
  return data;
}

export async function deleteVideoComment({ videoId, commentId, userId }) {
  if (!supabase) throw new Error('Video interactions temporarily unavailable.');
  const { data, error } = await supabase.rpc('delete_video_comment', {
    p_video_id: videoId,
    p_comment_id: commentId,
    p_user_id: userId,
  });
  if (error) throw error;
  return data;
}
