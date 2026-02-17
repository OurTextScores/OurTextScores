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
    <header className="sticky top-0 z-40 mb-4 border-b border-slate-200/80 bg-white/80 backdrop-blur supports-[backdrop-filter]:bg-white/60 dark:border-slate-800/70 dark:bg-slate-950/70">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-3 py-2 transition-colors">
        <Link href="/welcome" className="text-sm font-semibold text-slate-800 hover:underline dark:text-slate-100">
          OurTextScores
        </Link>
        <div className="flex items-center gap-3">
          <Link href="/catalogue" className="text-xs text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300">Catalogue</Link>
          <Link href="/projects" className="text-xs text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300">Projects</Link>
          <Link href="/score-editor" className="text-xs text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300">Score Editor</Link>
          <Link href="/tos" className="text-xs text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300">Terms</Link>
          <Link href="/privacy" className="text-xs text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300">Privacy</Link>
          <Link href="/dmca" className="text-xs text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300">DMCA</Link>
          <ThemeToggle />
          {user ? (
            <>
              {effectiveUsername ? (
                <Link
                  href={`/users/${encodeURIComponent(effectiveUsername)}`}
                  className="text-xs text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300"
                >
                  {userDisplay}
                </Link>
              ) : (
                <span className="text-xs text-slate-700 dark:text-slate-300">{userDisplay}</span>
              )}
              <Link href="/notifications" className="relative text-xs text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300">
                Notifications
                {unreadCount > 0 && (
                  <span className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </Link>
              <Link href="/approvals" className="text-xs text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300">Approvals</Link>
              <Link href="/settings" className="text-xs text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300">Settings</Link>
              <button onClick={() => signOut()} className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">
                Sign out
              </button>
            </>
          ) : (
            <Link href="/signin" className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">
              Sign in
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
