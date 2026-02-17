import Link from "next/link";
import { getApiBase } from "../lib/api";
import { getApiAuthHeaders } from "../lib/authToken";
import { ProfileForm } from "./profile-form";
import { NotificationsForm } from "./notifications-form";

export default async function SettingsPage() {
  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const res = await fetch(`${API_BASE}/users/me`, { headers, cache: 'no-store' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || 'Failed to load user');
  }
  const data = await res.json();
  const user = data?.user;
  const pref = (user?.notify?.watchPreference as 'immediate' | 'daily' | 'weekly' | undefined) || 'immediate';
  const roles: string[] = Array.isArray(user?.roles) ? user.roles as string[] : [];
  const roleLabel = roles.length ? roles.join(", ") : "user";

  return (
    <main className="min-h-screen bg-slate-50 py-10 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto w-full max-w-3xl px-6">
        <h1 className="mb-6 text-2xl font-semibold">Settings</h1>

        <section className="mb-6 rounded border border-slate-200 bg-white p-5 text-sm dark:border-slate-800 dark:bg-slate-900/60">
          <h2 className="mb-3 text-lg font-semibold">Profile</h2>
          <ProfileForm email={user?.email || ''} username={user?.username} />
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            Account roles: {roleLabel}
          </p>
          {user?.username && (
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              Public profile:{" "}
              <Link
                href={`/users/${encodeURIComponent(user.username as string)}`}
                className="text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300"
              >
                @{user.username}
              </Link>
            </p>
          )}
        </section>

        <section className="rounded border border-slate-200 bg-white p-5 text-sm dark:border-slate-800 dark:bg-slate-900/60">
          <h2 className="mb-3 text-lg font-semibold">Notifications</h2>
          <NotificationsForm preference={pref} />
        </section>

        {roles.includes('admin') && (
          <section className="mt-6 rounded border border-rose-200 bg-rose-50 p-5 text-sm dark:border-rose-900 dark:bg-rose-950/30">
            <h2 className="mb-3 text-lg font-semibold text-rose-900 dark:text-rose-100">Admin Tools</h2>
            <div className="space-y-2">
              <Link
                href="/admin/flagged-comments"
                className="block text-rose-700 underline-offset-2 hover:underline dark:text-rose-300"
              >
                Flagged Comments Dashboard
              </Link>
              <Link
                href="/admin/flagged-sources"
                className="block text-rose-700 underline-offset-2 hover:underline dark:text-rose-300"
              >
                Flagged Sources Dashboard
              </Link>
              <Link
                href="/admin/dmca-cases"
                className="block text-rose-700 underline-offset-2 hover:underline dark:text-rose-300"
              >
                DMCA Cases Dashboard
              </Link>
              <Link
                href="/admin/beta-requests"
                className="block text-rose-700 underline-offset-2 hover:underline dark:text-rose-300"
              >
                Beta Request Inbox
              </Link>
              <Link
                href="/pdmx"
                className="block text-rose-700 underline-offset-2 hover:underline dark:text-rose-300"
              >
                PDMX Browser
              </Link>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
