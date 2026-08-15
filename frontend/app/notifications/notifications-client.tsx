"use client";

import { useState } from "react";
import Link from "next/link";

interface Notification {
  notificationId: string;
  type: 'comment_reply' | 'source_comment' | 'new_revision' | 'approval_request' | 'change_review_submitted' | 'change_review_activity' | 'scanner_job_succeeded' | 'scanner_job_partial' | 'scanner_job_failed';
  workId?: string;
  sourceId?: string;
  revisionId?: string;
  resourceType?: string;
  resourceId?: string;
  payload: Record<string, any>;
  actorUsername?: string;
  read: boolean;
  createdAt: Date;
}

interface Props {
  initialNotifications: Notification[];
}

export default function NotificationsClient({ initialNotifications }: Props) {
  const [notifications, setNotifications] = useState<Notification[]>(initialNotifications);
  const [loading, setLoading] = useState<string | null>(null);

  const getNotificationText = (n: Notification): { title: string; description: string; preview?: string } => {
    const actor = n.actorUsername || "Someone";
    const commentContent = n.payload?.commentContent;
    const preview = commentContent ? (commentContent.length > 100 ? commentContent.slice(0, 100) + '...' : commentContent) : undefined;

    switch (n.type) {
      case 'comment_reply':
        return {
          title: `${actor} replied to your comment`,
          description: `on ${n.workId}`,
          preview
        };
      case 'source_comment':
        return {
          title: `${actor} commented on your source`,
          description: `${n.workId}/${n.sourceId}`,
          preview
        };
      case 'new_revision':
        return {
          title: `New revision on watched work`,
          description: `${n.workId}/${n.sourceId}`
        };
      case 'approval_request':
        return {
          title: 'Revision approval requested',
          description: `${n.workId}/${n.sourceId}`
        };
      case 'change_review_submitted':
        return {
          title: `${actor} submitted a change review`,
          description: `${n.workId}/${n.sourceId}`,
        };
      case 'change_review_activity': {
        const activityType = String(n.payload?.activityType || '');
        const branchName = n.payload?.branchName ? ` on ${n.payload.branchName}` : '';
        const contentPreview = typeof n.payload?.contentPreview === 'string' ? n.payload.contentPreview : undefined;
        const previewText = contentPreview
          ? (contentPreview.length > 100 ? `${contentPreview.slice(0, 100)}...` : contentPreview)
          : undefined;
        const title = activityType === 'thread_created'
          ? `${actor} opened a change review thread`
          : activityType === 'comment_added'
            ? `${actor} replied on a change review`
            : activityType === 'review_closed'
              ? `${actor} closed a change review`
              : activityType === 'review_reopened'
                ? `${actor} reopened a change review`
                : `${actor} updated a change review`;
        return {
          title,
          description: `${n.workId}/${n.sourceId}${branchName}`,
          preview: previewText,
        };
      }
      case 'scanner_job_succeeded':
        return { title: "Scan complete", description: String(n.payload?.originalFilename || "Your score is ready") };
      case 'scanner_job_partial':
        return { title: "Scan partially complete", description: String(n.payload?.originalFilename || "Some pages are ready") };
      case 'scanner_job_failed':
        return { title: "Scan failed", description: String(n.payload?.originalFilename || "The score could not be scanned") };
      default:
        return {
          title: "Notification",
          description: n.workId || "OurTextScores"
        };
    }
  };

  const getNotificationLink = (n: Notification): string => {
    if (n.resourceType === 'scanner_job' && n.resourceId) {
      return `/scanner/${encodeURIComponent(n.resourceId)}`;
    }
    if ((n.type === 'change_review_submitted' || n.type === 'change_review_activity') && n.payload?.reviewId) {
      return `/change-reviews/${encodeURIComponent(String(n.payload.reviewId))}`;
    }
    if (n.type === 'approval_request') return '/approvals';
    // Create deep link with URL parameters to open specific source/revision
    const params = new URLSearchParams({
      source: n.sourceId || "",
      revision: n.revisionId || ""
    });
    if (n.payload?.commentId) {
      params.set('comment', n.payload.commentId);
    }
    return `/works/${encodeURIComponent(n.workId || "")}?${params.toString()}`;
  };

  const handleMarkAsRead = async (notificationId: string) => {
    setLoading(notificationId);

    try {
      const res = await fetch(`/api/proxy/notifications/${encodeURIComponent(notificationId)}/read`, {
        method: "POST"
      });

      if (!res.ok) {
        throw new Error("Failed to mark as read");
      }

      // Update local state
      setNotifications(prev =>
        prev.map(n => n.notificationId === notificationId ? { ...n, read: true } : n)
      );
    } catch (err) {
      console.error("Error marking notification as read:", err);
      alert("Failed to mark as read. Please try again.");
    } finally {
      setLoading(null);
    }
  };

  const handleMarkAllAsRead = async () => {
    setLoading("all");

    try {
      const res = await fetch("/api/proxy/notifications/mark-all-read", {
        method: "POST"
      });

      if (!res.ok) {
        throw new Error("Failed to mark all as read");
      }

      // Update local state
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    } catch (err) {
      console.error("Error marking all as read:", err);
      alert("Failed to mark all as read. Please try again.");
    } finally {
      setLoading(null);
    }
  };

  const formatDate = (date: Date) => {
    return new Date(date).toLocaleString();
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'comment_reply':
        return '💬';
      case 'source_comment':
        return '📝';
      case 'new_revision':
        return '📄';
      case 'approval_request':
        return '✅';
      case 'change_review_submitted':
        return '🧾';
      case 'change_review_activity':
        return '🗨️';
      case 'scanner_job_succeeded':
      case 'scanner_job_partial':
      case 'scanner_job_failed':
        return '🎼';
      default:
        return '🔔';
    }
  };

  const unreadCount = notifications.filter(n => !n.read).length;

  return (
    <div className="space-y-4">
      {unreadCount > 0 && (
        <div className="flex justify-end">
          <button
            onClick={handleMarkAllAsRead}
            disabled={loading === "all"}
            className="text-sm text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading === "all" ? "Marking all..." : "Mark all as read"}
          </button>
        </div>
      )}

      <div className="space-y-2">
        {notifications.map((notification) => {
          const { title, description, preview } = getNotificationText(notification);
          const isLoading = loading === notification.notificationId;
          const notificationLink = getNotificationLink(notification);

          return (
            <div
              key={notification.notificationId}
              className={`border rounded-lg p-4 transition-colors ${
                notification.read
                  ? 'bg-slate-50 dark:bg-slate-900/30 border-slate-200 dark:border-slate-800'
                  : 'bg-white dark:bg-slate-800 border-blue-200 dark:border-blue-900'
              }`}
            >
              <div className="flex items-start gap-3">
                <span className="text-2xl">{getTypeIcon(notification.type)}</span>

                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-slate-900 dark:text-slate-100">
                          {title}
                        </h3>
                        {!notification.read && (
                          <span className="w-2 h-2 bg-blue-500 rounded-full"></span>
                        )}
                      </div>
                      <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                        {description}
                      </p>
                      {preview && (
                        <div className="mt-2 p-2 bg-slate-100 dark:bg-slate-800 rounded border border-slate-200 dark:border-slate-700">
                          <p className="text-sm text-slate-700 dark:text-slate-300 italic">
                            &ldquo;{preview}&rdquo;
                          </p>
                        </div>
                      )}
                      <p className="text-xs text-slate-500 dark:text-slate-500 mt-1">
                        {formatDate(notification.createdAt)}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <Link
                        href={notificationLink}
                        className="text-sm text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
                      >
                        View
                      </Link>
                      {!notification.read && (
                        <button
                          onClick={() => handleMarkAsRead(notification.notificationId)}
                          disabled={isLoading}
                          className="text-sm text-slate-600 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-300 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {isLoading ? "..." : "Mark read"}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
