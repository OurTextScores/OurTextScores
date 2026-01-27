"use client";

import { useState } from "react";
import Link from "next/link";

interface FlaggedComment {
  commentId: string;
  workId: string;
  sourceId: string;
  revisionId: string;
  revisionSeq: number;
  content: string;
  userId: string;
  username?: string;
  flaggedBy?: string;
  flaggedByUsername?: string;
  flagReason?: string;
  flaggedAt?: Date;
  createdAt: Date;
  voteScore: number;
}

interface Props {
  initialComments: FlaggedComment[];
}

export default function FlaggedCommentsClient({ initialComments }: Props) {
  const [comments, setComments] = useState<FlaggedComment[]>(initialComments);
  const [loading, setLoading] = useState<string | null>(null);

  const handleUnflag = async (commentId: string, workId: string, sourceId: string, revisionId: string) => {
    if (!confirm("Remove flag from this comment?")) return;

    setLoading(commentId);

    try {
      const res = await fetch(
        `/api/proxy/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/revisions/${encodeURIComponent(revisionId)}/comments/${encodeURIComponent(commentId)}/flag`,
        {
          method: "DELETE"
        }
      );

      if (!res.ok) {
        throw new Error("Failed to unflag comment");
      }

      // Remove from list
      setComments(prev => prev.filter(c => c.commentId !== commentId));
    } catch (err) {
      console.error("Error unflagging comment:", err);
      alert("Failed to unflag comment. Please try again.");
    } finally {
      setLoading(null);
    }
  };

  const handleDelete = async (commentId: string, workId: string, sourceId: string, revisionId: string) => {
    if (!confirm("Permanently delete this comment? This cannot be undone.")) return;

    setLoading(commentId);

    try {
      const res = await fetch(
        `/api/proxy/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/revisions/${encodeURIComponent(revisionId)}/comments/${encodeURIComponent(commentId)}`,
        {
          method: "DELETE"
        }
      );

      if (!res.ok) {
        throw new Error("Failed to delete comment");
      }

      // Remove from list
      setComments(prev => prev.filter(c => c.commentId !== commentId));
    } catch (err) {
      console.error("Error deleting comment:", err);
      alert("Failed to delete comment. Please try again.");
    } finally {
      setLoading(null);
    }
  };

  const formatDate = (date: Date | undefined) => {
    if (!date) return "N/A";
    return new Date(date).toLocaleString();
  };

  const getVoteScoreColor = (score: number) => {
    if (score > 0) return "text-green-600 dark:text-green-400";
    if (score < 0) return "text-red-600 dark:text-red-400";
    return "text-slate-600 dark:text-slate-400";
  };

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-700">
        <thead className="bg-slate-50 dark:bg-slate-900">
          <tr>
            <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              Work / Source / Revision
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              Comment
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              Author
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              Flagged By
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              Reason
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              Vote Score
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              Flagged At
            </th>
            <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="bg-white dark:bg-slate-800 divide-y divide-slate-200 dark:divide-slate-700">
          {comments.map((comment) => (
            <tr key={comment.commentId} className="hover:bg-slate-50 dark:hover:bg-slate-700/50">
              <td className="px-4 py-4 text-sm">
                <Link
                  href={`/works/${encodeURIComponent(comment.workId)}`}
                  className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
                >
                  {comment.workId}
                </Link>
                <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  Source: {comment.sourceId}
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Rev #{comment.revisionSeq ?? "?"} ({comment.revisionId?.slice(0, 8) ?? "unknown"}...)
                </div>
              </td>

              <td className="px-4 py-4 text-sm max-w-md">
                <div className="text-slate-900 dark:text-slate-100 line-clamp-3">
                  {comment.content}
                </div>
                <div className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                  Posted: {formatDate(comment.createdAt)}
                </div>
              </td>

              <td className="px-4 py-4 text-sm">
                <div className="text-slate-900 dark:text-slate-100">
                  {comment.username || comment.userId || "Unknown"}
                </div>
                {comment.userId && (
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {comment.userId.slice(0, 8)}...
                  </div>
                )}
              </td>

              <td className="px-4 py-4 text-sm">
                <div className="text-slate-900 dark:text-slate-100">
                  {comment.flaggedByUsername || comment.flaggedBy || "Unknown"}
                </div>
                {comment.flaggedBy && (
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {comment.flaggedBy.slice(0, 8)}...
                  </div>
                )}
              </td>

              <td className="px-4 py-4 text-sm text-slate-700 dark:text-slate-300 max-w-xs">
                {comment.flagReason || "No reason provided"}
              </td>

              <td className="px-4 py-4 text-sm">
                <span className={`font-semibold ${getVoteScoreColor(comment.voteScore)}`}>
                  {comment.voteScore > 0 ? "+" : ""}{comment.voteScore}
                </span>
              </td>

              <td className="px-4 py-4 text-sm text-slate-500 dark:text-slate-400">
                {formatDate(comment.flaggedAt)}
              </td>

              <td className="px-4 py-4 text-sm text-right space-x-2">
                <button
                  onClick={() => handleUnflag(comment.commentId, comment.workId, comment.sourceId, comment.revisionId)}
                  disabled={loading === comment.commentId}
                  className="inline-flex items-center px-3 py-1 border border-transparent text-xs font-medium rounded text-green-700 bg-green-100 hover:bg-green-200 dark:text-green-100 dark:bg-green-900/50 dark:hover:bg-green-900 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading === comment.commentId ? "..." : "Unflag"}
                </button>

                <button
                  onClick={() => handleDelete(comment.commentId, comment.workId, comment.sourceId, comment.revisionId)}
                  disabled={loading === comment.commentId}
                  className="inline-flex items-center px-3 py-1 border border-transparent text-xs font-medium rounded text-red-700 bg-red-100 hover:bg-red-200 dark:text-red-100 dark:bg-red-900/50 dark:hover:bg-red-900 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading === comment.commentId ? "..." : "Delete"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
