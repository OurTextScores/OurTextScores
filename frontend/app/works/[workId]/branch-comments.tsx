"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

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

export default function BranchComments({
  workId,
  sourceId,
  branchName,
  currentUser
}: {
  workId: string;
  sourceId: string;
  branchName: string;
  currentUser?: { userId: string; email?: string; name?: string; isAdmin: boolean } | null;
}) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [newComment, setNewComment] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const basePath = `/api/proxy/works/${workId}/sources/${sourceId}/branches/${encodeURIComponent(branchName)}/comments`;

  const loadComments = async () => {
    try {
      const res = await fetch(basePath);
      if (res.ok) {
        const data = await res.json();
        setComments(data);
      } else {
        setError("Failed to load comments");
      }
    } catch {
      setError("Failed to load comments");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadComments();
  }, [basePath]);

  const handleSubmitComment = async () => {
    if (!newComment.trim() || !currentUser) return;

    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch(basePath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: newComment.trim() })
      });

      if (res.ok) {
        setNewComment("");
        await loadComments();
      } else {
        const data = await res.json();
        setError(data.message || "Failed to post comment");
      }
    } catch {
      setError("Failed to post comment");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loading) {
    return <div className="text-xs text-slate-500 dark:text-slate-400">Loading comments...</div>;
  }

  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Branch comments ({comments.length})
      </div>
      {error && (
        <div className="rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-900/50 dark:text-rose-200">
          {error}
        </div>
      )}
      {currentUser ? (
        <div className="space-y-2">
          <textarea
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            placeholder="Write a branch comment..."
            rows={3}
            className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
          <button
            onClick={() => void handleSubmitComment()}
            disabled={isSubmitting || !newComment.trim()}
            className="rounded border border-cyan-300 bg-cyan-50 px-4 py-2 text-sm font-semibold text-cyan-700 hover:bg-cyan-100 disabled:opacity-50 dark:border-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-200"
          >
            {isSubmitting ? "Posting..." : "Post comment"}
          </button>
        </div>
      ) : (
        <div className="text-xs text-slate-600 dark:text-slate-400">Sign in to post comments</div>
      )}
      <div className="space-y-4">
        {comments.map(comment => (
          <CommentItem
            key={comment.commentId}
            comment={comment}
            workId={workId}
            sourceId={sourceId}
            branchName={branchName}
            currentUser={currentUser}
            onUpdate={loadComments}
            depth={0}
          />
        ))}
      </div>
      {comments.length === 0 && (
        <div className="py-2 text-sm text-slate-500 dark:text-slate-400">No comments yet.</div>
      )}
    </div>
  );
}

function CommentItem({
  comment,
  workId,
  sourceId,
  branchName,
  currentUser,
  onUpdate,
  depth
}: {
  comment: Comment;
  workId: string;
  sourceId: string;
  branchName: string;
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

  const basePath = `/api/proxy/works/${workId}/sources/${sourceId}/branches/${encodeURIComponent(branchName)}/comments`;
  const isOwner = currentUser?.userId === comment.userId;
  const isAdmin = currentUser?.isAdmin ?? false;

  const handleVote = async (voteType: 'up' | 'down') => {
    if (!currentUser) return;
    const res = await fetch(`${basePath}/${comment.commentId}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voteType })
    });
    if (res.ok) {
      await onUpdate();
    }
  };

  const handleReply = async () => {
    if (!replyContent.trim() || !currentUser) return;
    setIsSubmitting(true);
    try {
      const res = await fetch(basePath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: replyContent.trim(), parentCommentId: comment.commentId })
      });
      if (res.ok) {
        setReplyContent("");
        setIsReplying(false);
        await onUpdate();
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEdit = async () => {
    if (!editContent.trim()) return;
    setIsSubmitting(true);
    try {
      const res = await fetch(`${basePath}/${comment.commentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editContent.trim() })
      });
      if (res.ok) {
        setIsEditing(false);
        await onUpdate();
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm("Delete this comment?")) return;
    const res = await fetch(`${basePath}/${comment.commentId}`, { method: "DELETE" });
    if (res.ok) {
      await onUpdate();
    }
  };

  const handleFlag = async () => {
    if (!flagReason.trim()) return;
    const res = await fetch(`${basePath}/${comment.commentId}/flag`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: flagReason.trim() })
    });
    if (res.ok) {
      setFlagReason("");
      setShowFlagForm(false);
      await onUpdate();
    }
  };

  const handleUnflag = async () => {
    const res = await fetch(`${basePath}/${comment.commentId}/flag`, { method: "DELETE" });
    if (res.ok) {
      await onUpdate();
    }
  };

  return (
    <div id={`comment-${comment.commentId}`} className={`space-y-2 rounded border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/40 ${depth > 0 ? "ml-4" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm">
            <span className="font-semibold text-slate-900 dark:text-slate-100">{comment.username}</span>
            <span className="text-xs text-slate-500 dark:text-slate-400">{new Date(comment.createdAt).toLocaleString()}</span>
          </div>
          {isEditing ? (
            <div className="mt-2 space-y-2">
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                rows={3}
                className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
              <div className="flex gap-2">
                <button onClick={() => void handleEdit()} disabled={isSubmitting} className="rounded border border-cyan-300 bg-cyan-50 px-3 py-1 text-xs font-semibold text-cyan-700 disabled:opacity-50">Save</button>
                <button onClick={() => setIsEditing(false)} className="rounded border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700">Cancel</button>
              </div>
            </div>
          ) : (
            <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-300">{comment.content}</p>
          )}
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400">Score {comment.voteScore}</div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button onClick={() => void handleVote('up')} className="text-slate-600 hover:text-slate-900 dark:text-slate-300">▲</button>
        <button onClick={() => void handleVote('down')} className="text-slate-600 hover:text-slate-900 dark:text-slate-300">▼</button>
        {currentUser && (
          <button onClick={() => setIsReplying((value) => !value)} className="text-cyan-700 hover:underline dark:text-cyan-300">Reply</button>
        )}
        {isOwner && !isEditing && (
          <button onClick={() => setIsEditing(true)} className="text-cyan-700 hover:underline dark:text-cyan-300">Edit</button>
        )}
        {(isOwner || isAdmin) && (
          <button onClick={() => void handleDelete()} className="text-rose-700 hover:underline dark:text-rose-300">Delete</button>
        )}
        {currentUser && !isOwner && (
          <button onClick={() => setShowFlagForm((value) => !value)} className="text-amber-700 hover:underline dark:text-amber-300">Flag</button>
        )}
        {isAdmin && comment.flagged && (
          <button onClick={() => void handleUnflag()} className="text-amber-700 hover:underline dark:text-amber-300">Clear flag</button>
        )}
      </div>

      {showFlagForm && (
        <div className="space-y-2">
          <input
            type="text"
            value={flagReason}
            onChange={(e) => setFlagReason(e.target.value)}
            placeholder="Reason for flagging"
            className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
          <button onClick={() => void handleFlag()} className="rounded border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">Submit flag</button>
        </div>
      )}

      {isReplying && currentUser && (
        <div className="space-y-2">
          <textarea
            value={replyContent}
            onChange={(e) => setReplyContent(e.target.value)}
            rows={3}
            placeholder="Write a reply..."
            className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
          <div className="flex gap-2">
            <button onClick={() => void handleReply()} disabled={isSubmitting || !replyContent.trim()} className="rounded border border-cyan-300 bg-cyan-50 px-3 py-1 text-xs font-semibold text-cyan-700 disabled:opacity-50">Reply</button>
            <button onClick={() => setIsReplying(false)} className="rounded border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700">Cancel</button>
          </div>
        </div>
      )}

      {comment.replies.length > 0 && (
        <div className="space-y-3">
          {comment.replies.map((reply) => (
            <CommentItem
              key={reply.commentId}
              comment={reply}
              workId={workId}
              sourceId={sourceId}
              branchName={branchName}
              currentUser={currentUser}
              onUpdate={onUpdate}
              depth={depth + 1}
            />
          ))}
        </div>
      )}

      {!currentUser && (
        <div className="text-xs text-slate-500 dark:text-slate-400">
          <Link href="/api/auth/signin" className="text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300">Sign in</Link> to participate.
        </div>
      )}
    </div>
  );
}
