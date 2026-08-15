import { redirect } from "next/navigation";
import Link from "next/link";
import { fetchBackendSession } from "../lib/server-session";
import { getApiAuthHeaders } from "../lib/authToken";
import NotificationsClient from "./notifications-client";
import { NotificationsForm } from "../settings/notifications-form";
import type { NotificationEmailCategories } from "../settings/actions";

function getBackendApiBase(): string {
  const raw = process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:4000/api";
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

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

interface NotificationPreferences {
  preference: 'immediate' | 'daily' | 'weekly';
  emailEnabled: boolean;
  emailCategories: NotificationEmailCategories;
}

const defaultEmailCategories: NotificationEmailCategories = {
  comments: true,
  revisions: true,
  reviews: true,
  scanner: true,
  approvals: true
};

async function fetchNotifications(): Promise<{ notifications: Notification[]; unreadCount: number }> {
  const API = getBackendApiBase();
  const auth = await getApiAuthHeaders();

  try {
    const res = await fetch(`${API}/notifications`, {
      headers: {
        "Content-Type": "application/json",
        ...(auth.Authorization && { Authorization: auth.Authorization })
      },
      cache: "no-store"
    });

    if (!res.ok) {
      console.error("Failed to fetch notifications:", res.status);
      return { notifications: [], unreadCount: 0 };
    }

    return res.json();
  } catch (err) {
    console.error("Error fetching notifications:", err);
    return { notifications: [], unreadCount: 0 };
  }
}

async function fetchNotificationPreferences(): Promise<NotificationPreferences> {
  const API = getBackendApiBase();
  const auth = await getApiAuthHeaders();
  const fallback: NotificationPreferences = {
    preference: 'immediate',
    emailEnabled: true,
    emailCategories: { ...defaultEmailCategories }
  };

  try {
    const res = await fetch(`${API}/users/me`, {
      headers: {
        "Content-Type": "application/json",
        ...(auth.Authorization && { Authorization: auth.Authorization })
      },
      cache: "no-store"
    });
    if (!res.ok) return fallback;
    const user = (await res.json())?.user;
    return {
      preference: user?.notify?.watchPreference || 'immediate',
      emailEnabled: user?.notify?.emailEnabled !== false,
      emailCategories: {
        comments: user?.notify?.emailCategories?.comments !== false,
        revisions: user?.notify?.emailCategories?.revisions !== false,
        reviews: user?.notify?.emailCategories?.reviews !== false,
        scanner: user?.notify?.emailCategories?.scanner !== false,
        approvals: user?.notify?.emailCategories?.approvals !== false
      }
    };
  } catch {
    return fallback;
  }
}

export default async function NotificationsPage() {
  const session = await fetchBackendSession();

  if (!session?.user) {
    redirect("/");
  }

  const [{ notifications, unreadCount }, preferences] = await Promise.all([
    fetchNotifications(),
    fetchNotificationPreferences()
  ]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 py-8 px-4">
      <div className="max-w-4xl mx-auto">
        <div className="mb-6">
          <Link
            href="/"
            className="text-sm text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
          >
            ← Back to Home
          </Link>
        </div>

        <div className="bg-white dark:bg-slate-800 rounded-lg shadow-lg p-6">
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-3xl font-bold text-slate-900 dark:text-slate-100">
              Notifications
            </h1>
            {unreadCount > 0 && (
              <span className="px-3 py-1 bg-blue-500 text-white text-sm font-semibold rounded-full">
                {unreadCount} unread
              </span>
            )}
          </div>

          {notifications.length === 0 ? (
            <div className="text-center py-12 text-slate-500 dark:text-slate-400">
              No notifications yet.
            </div>
          ) : (
            <NotificationsClient initialNotifications={notifications} />
          )}
        </div>

        <section
          id="notification-settings"
          className="mt-6 rounded-lg bg-white p-6 text-sm shadow-lg dark:bg-slate-800"
        >
          <h2 className="mb-2 text-xl font-semibold text-slate-900 dark:text-slate-100">
            Notification email settings
          </h2>
          <p className="mb-4 text-sm text-slate-600 dark:text-slate-400">
            Choose which notification emails to receive, or unsubscribe from all of them.
            In-app notifications remain available here.
          </p>
          <NotificationsForm
            preference={preferences.preference}
            emailEnabled={preferences.emailEnabled}
            emailCategories={preferences.emailCategories}
          />
        </section>
      </div>
    </div>
  );
}
