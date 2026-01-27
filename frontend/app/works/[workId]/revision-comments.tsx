"use client";

import { useState, useEffect } from "react";

interface Comment {
  commentId: string;
  userId: string;
  username: string;
  content: string;
  voteScore: number;
  createdAt: string;
  editedAt?: string;
  flagged?: boolean;
  userVote?: 'up' | 'down';
  replies: Comment[];
}

export default function RevisionComments({
  workId,
  sourceId,
  revisionId,
  currentUser
}: {
  workId: string;
  sourceId: string;
  revisionId: string;
  currentUser?: { userId: string; email?: string; name?: string; isAdmin: boolean } | null;
}) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [newComment, setNewComment] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadComments = async () => {
    try {
      const res = await fetch(`/api/proxy/works/${workId}/sources/${sourceId}/revisions/${revisionId}/comments`);
      if (res.ok) {
        const data = await res.json();
        setComments(data);
      } else {
        setError("Failed to load comments");
      }
    } catch (err) {
      console.error("Failed to load comments:", err);
      setError("Failed to load comments");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadComments();
  }, [workId, sourceId, revisionId]);

  const handleSubmitComment = async () => {
    if (!newComment.trim() || !currentUser) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/proxy/works/${workId}/sources/${sourceId}/revisions/${revisionId}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ content: newComment.trim() })
      });

      if (res.ok) {
        setNewComment("");
        await loadComments();
      } else {
        const data = await res.json();
        setError(data.message || "Failed to post comment");
      }
    } catch (err) {
      console.error("Failed to post comment:", err);
      setError("Failed to post comment");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="px-5 py-4 border-t border-slate-200 dark:border-slate-800">
        <div className="text-xs text-slate-500 dark:text-slate-400">Loading comments...</div>
      </div>
    );
  }

  return (
    <div className="px-5 py-4 border-t border-slate-200 dark:border-slate-800">
      <h3 className="mb-3 text-sm font-semibold text-slate-800 dark:text-slate-200">
        Comments ({comments.length})
      </h3>

      {error && (
        <div className="mb-3 rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-900/50 dark:text-rose-200">
          {error}
        </div>
      )}

      {/* New comment form */}
      {currentUser ? (
        <div className="mb-4 space-y-2">
          <textarea
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            placeholder="Write a comment..."
            rows={3}
            className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:placeholder-slate-500"
          />
          <button
            onClick={handleSubmitComment}
            disabled={isSubmitting || !newComment.trim()}
            className="rounded border border-cyan-300 bg-cyan-50 px-4 py-2 text-sm font-semibold text-cyan-700 transition hover:bg-cyan-100 disabled:opacity-50 dark:border-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-200 dark:hover:bg-cyan-900"
          >
            {isSubmitting ? 'Posting...' : 'Post Comment'}
          </button>
        </div>
      ) : (
        <div className="mb-4 text-xs text-slate-600 dark:text-slate-400">
          Sign in to post comments
        </div>
      )}

      {/* Comments list */}
      <div className="space-y-4">
        {comments.map(comment => (
          <CommentItem
            key={comment.commentId}
            comment={comment}
            workId={workId}
            sourceId={sourceId}
            revisionId={revisionId}
            currentUser={currentUser}
            onUpdate={loadComments}
            depth={0}
          />
        ))}
      </div>

      {comments.length === 0 && (
        <div className="text-center text-sm text-slate-500 dark:text-slate-400 py-4">
          No comments yet. Be the first to comment!
        </div>
      )}
    </div>
  );
}

function CommentItem({
  comment,
  workId,
  sourceId,
  revisionId,
  currentUser,
  onUpdate,
  depth
}: {
  comment: Comment;
  workId: string;
  sourceId: string;
  revisionId: string;
  currentUser?: { userId: string; email?: string; name?: string; isAdmin: boolean } | null;
  onUpdate: () => void;
  depth: number;
}) {
  const [isReplying, setIsReplying] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [replyContent, setReplyContent] = useState("");
  const [editContent, setEditContent] = useState(comment.content);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showFlagForm, setShowFlagForm] = useState(false);
  const [flagReason, setFlagReason] = useState("");

  const isOwner = currentUser?.userId === comment.userId;
  const isAdmin = currentUser?.isAdmin ?? false;

  const handleVote = async (voteType: 'up' | 'down') => {
    if (!currentUser) return;

    try {
      const res = await fetch(
        `/api/proxy/works/${workId}/sources/${sourceId}/revisions/${revisionId}/comments/${comment.commentId}/vote`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ voteType })
        }
      );

      if (res.ok) {
        await onUpdate();
      }
    } catch (err) {
      console.error("Vote failed:", err);
    }
  };

  const handleReply = async () => {
    if (!replyContent.trim() || !currentUser) return;

    setIsSubmitting(true);
    try {
      const res = await fetch(`/api/proxy/works/${workId}/sources/${sourceId}/revisions/${revisionId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: replyContent.trim(), parentCommentId: comment.commentId })
      });

      if (res.ok) {
        setReplyContent("");
        setIsReplying(false);
        await onUpdate();
      }
    } catch (err) {
      console.error("Reply failed:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEdit = async () => {
    if (!editContent.trim()) return;

    setIsSubmitting(true);
    try {
      const res = await fetch(
        `/api/proxy/works/${workId}/sources/${sourceId}/revisions/${revisionId}/comments/${comment.commentId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: editContent.trim() })
        }
      );

      if (res.ok) {
        setIsEditing(false);
        await onUpdate();
      }
    } catch (err) {
      console.error("Edit failed:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm("Delete this comment?")) return;

    try {
      const res = await fetch(
        `/api/proxy/works/${workId}/sources/${sourceId}/revisions/${revisionId}/comments/${comment.commentId}`,
        { method: "DELETE" }
      );

      if (res.ok) {
        await onUpdate();
      }
    } catch (err) {
      console.error("Delete failed:", err);
    }
  };

  const handleFlag = async () => {
    if (!flagReason.trim()) return;

    setIsSubmitting(true);
    try {
      const res = await fetch(
        `/api/proxy/works/${workId}/sources/${sourceId}/revisions/${revisionId}/comments/${comment.commentId}/flag`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: flagReason.trim() })
        }
      );

      if (res.ok) {
        setFlagReason("");
        setShowFlagForm(false);
        await onUpdate();
      }
    } catch (err) {
      console.error("Flag failed:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUnflag = async () => {
    try {
      const res = await fetch(
        `/api/proxy/works/${workId}/sources/${sourceId}/revisions/${revisionId}/comments/${comment.commentId}/flag`,
        { method: "DELETE" }
      );

      if (res.ok) {
        await onUpdate();
      }
    } catch (err) {
      console.error("Unflag failed:", err);
    }
  };

  const marginLeft = depth > 0 ? `${depth * 2}rem` : '0';

  return (
    <div style={{ marginLeft }} className="space-y-2">
      <div className={`rounded border p-3 ${comment.flagged ? 'border-rose-300 bg-rose-50 dark:border-rose-700 dark:bg-rose-900/20' : 'border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/40'}`}>
        {/* Header */}
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">{comment.username}</span>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {new Date(comment.createdAt).toLocaleString()}
          </span>
          {comment.editedAt && (
            <span className="text-xs text-slate-400 dark:text-slate-500">(edited)</span>
          )}
          {comment.flagged && (
            <span className="text-xs text-rose-600 dark:text-rose-400 font-semibold">⚠ Flagged</span>
          )}
        </div>

        {/* Content */}
        {isEditing ? (
          <div className="space-y-2">
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              rows={3}
              className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
            <div className="flex gap-2">
              <button
                onClick={handleEdit}
                disabled={isSubmitting}
                className="rounded bg-cyan-500 px-3 py-1 text-xs font-semibold text-white hover:bg-cyan-600 disabled:opacity-50"
              >
                Save
              </button>
              <button
                onClick={() => {
                  setIsEditing(false);
                  setEditContent(comment.content);
                }}
                className="rounded bg-slate-300 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-400"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap">
            {comment.content}
          </div>
        )}

        {/* Actions */}
        <div className="mt-2 flex items-center gap-3 text-xs">
          {/* Voting */}
          {currentUser && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => handleVote('up')}
                className={`transition ${comment.userVote === 'up' ? 'text-cyan-600 dark:text-cyan-400' : 'text-slate-500 hover:text-cyan-600 dark:text-slate-400 dark:hover:text-cyan-400'}`}
              >
                ▲
              </button>
              <span className={`font-semibold ${comment.voteScore > 0 ? 'text-cyan-600 dark:text-cyan-400' : comment.voteScore < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-600 dark:text-slate-400'}`}>
                {comment.voteScore}
              </span>
              <button
                onClick={() => handleVote('down')}
                className={`transition ${comment.userVote === 'down' ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500 hover:text-rose-600 dark:text-slate-400 dark:hover:text-rose-400'}`}
              >
                ▼
              </button>
            </div>
          )}

          {!currentUser && (
            <span className="text-slate-600 dark:text-slate-400 font-semibold">
              {comment.voteScore} votes
            </span>
          )}

          {currentUser && !isEditing && (
            <button
              onClick={() => setIsReplying(!isReplying)}
              className="text-slate-600 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
            >
              Reply
            </button>
          )}

          {isOwner && !isEditing && (
            <button
              onClick={() => setIsEditing(true)}
              className="text-slate-600 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
            >
              Edit
            </button>
          )}

          {(isOwner || isAdmin) && !isEditing && (
            <button
              onClick={handleDelete}
              className="text-rose-600 hover:text-rose-800 dark:text-rose-400 dark:hover:text-rose-200"
            >
              Delete
            </button>
          )}

          {currentUser && !isOwner && !comment.flagged && !isEditing && (
            <button
              onClick={() => setShowFlagForm(!showFlagForm)}
              className="text-amber-600 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-200"
            >
              Flag
            </button>
          )}

          {isAdmin && comment.flagged && (
            <button
              onClick={handleUnflag}
              className="text-emerald-600 hover:text-emerald-800 dark:text-emerald-400 dark:hover:text-emerald-200"
            >
              Remove Flag
            </button>
          )}
        </div>
      </div>

      {/* Reply form */}
      {isReplying && (
        <div className="space-y-2 pl-4">
          <textarea
            value={replyContent}
            onChange={(e) => setReplyContent(e.target.value)}
            placeholder="Write a reply..."
            rows={2}
            className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:placeholder-slate-500"
          />
          <div className="flex gap-2">
            <button
              onClick={handleReply}
              disabled={isSubmitting || !replyContent.trim()}
              className="rounded bg-cyan-500 px-3 py-1 text-xs font-semibold text-white hover:bg-cyan-600 disabled:opacity-50"
            >
              {isSubmitting ? 'Posting...' : 'Post Reply'}
            </button>
            <button
              onClick={() => {
                setIsReplying(false);
                setReplyContent("");
              }}
              className="rounded bg-slate-300 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-400"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Flag form */}
      {showFlagForm && (
        <div className="space-y-2 pl-4">
          <textarea
            value={flagReason}
            onChange={(e) => setFlagReason(e.target.value)}
            placeholder="Why are you flagging this comment?"
            rows={2}
            className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:placeholder-slate-500"
          />
          <div className="flex gap-2">
            <button
              onClick={handleFlag}
              disabled={isSubmitting || !flagReason.trim()}
              className="rounded bg-amber-500 px-3 py-1 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
            >
              {isSubmitting ? 'Flagging...' : 'Flag Comment'}
            </button>
            <button
              onClick={() => {
                setShowFlagForm(false);
                setFlagReason("");
              }}
              className="rounded bg-slate-300 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-400"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Nested replies */}
      {comment.replies.length > 0 && (
        <div className="space-y-2">
          {comment.replies.map(reply => (
            <CommentItem
              key={reply.commentId}
              comment={reply}
              workId={workId}
              sourceId={sourceId}
              revisionId={revisionId}
              currentUser={currentUser}
              onUpdate={onUpdate}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}
