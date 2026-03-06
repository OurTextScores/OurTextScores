"use client";
import { useSession, signOut } from "next-auth/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import ThemeToggle from "../theme-toggle";

export default function Header() {
  const { data } = useSession();
  const user = data?.user;
  const usernameCandidate = (user as any)?.username ?? user?.name;
  const profileUsername =
    typeof usernameCandidate === "string" && /^[a-z0-9_]{3,20}$/.test(usernameCandidate)
      ? usernameCandidate
      : undefined;
  const [resolvedUsername, setResolvedUsername] = useState<string | undefined>(undefined);
  const effectiveUsername = resolvedUsername ?? profileUsername;
  const userDisplay = effectiveUsername || user?.name || user?.email;
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    if (user) {
      // Fetch unread notification count
      fetch("/api/proxy/notifications/unread-count")
        .then(res => res.json())
        .then(data => setUnreadCount(data.unreadCount || 0))
        .catch(() => setUnreadCount(0));

      // Resolve profile username when session only has email/name.
      fetch("/api/proxy/users/me")
        .then((res) => (res.ok ? res.json() : null))
        .then((profile) => {
          const username = profile?.user?.username ?? profile?.username;
          if (typeof username === "string" && /^[a-z0-9_]{3,20}$/.test(username)) {
            setResolvedUsername(username);
          } else {
            setResolvedUsername(undefined);
          }
        })
        .catch(() => setResolvedUsername(undefined));
    } else {
      setResolvedUsername(undefined);
      setUnreadCount(0);
    }
  }, [user]);

  return (
    <header className="sticky top-0 z-40 px-3 pt-3">
      <div className="ots-panel mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 transition-colors md:flex-row md:items-center md:justify-between">
        <Link href="/welcome" className="min-w-0">
          <div className="ots-kicker">Open musical texts</div>
          <div className="font-[var(--font-heading)] text-2xl leading-none text-slate-900 dark:text-slate-50">
            OurTextScores
          </div>
        </Link>
        <div className="flex flex-wrap items-center gap-1.5 md:justify-end">
          <Link href="/catalogue" className="ots-nav-link">Catalogue</Link>
          <Link href="/projects" className="ots-nav-link">Projects</Link>
          <Link href="/score-editor" className="ots-nav-link">Score Editor</Link>
          <Link href="/legal" className="ots-nav-link">Legal</Link>
          <ThemeToggle />
          {user ? (
            <>
              {effectiveUsername ? (
                <Link
                  href={`/users/${encodeURIComponent(effectiveUsername)}`}
                  className="ots-nav-link"
                >
                  {userDisplay}
                </Link>
              ) : (
                <span className="rounded-full px-3 py-2 text-sm text-slate-700 dark:text-slate-300">{userDisplay}</span>
              )}
              <Link href="/notifications" className="ots-nav-link relative">
                Notifications
                {unreadCount > 0 && (
                  <span className="absolute -right-1 top-0 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-slate-900 px-1 text-[10px] font-bold text-white dark:bg-sky-300 dark:text-slate-900">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </Link>
              <Link href="/approvals" className="ots-nav-link">Approvals</Link>
              <Link href="/settings" className="ots-nav-link">Settings</Link>
              <button onClick={() => signOut()} className="ots-button-secondary px-3 py-2 text-xs">
                Sign out
              </button>
            </>
          ) : (
            <Link href="/signin" className="ots-button-secondary px-3 py-2 text-xs">
              Sign in
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
