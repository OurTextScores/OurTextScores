import Link from "next/link";
import { redirect } from "next/navigation";
import { fetchBackendSession } from "../lib/server-session";
import type { ReactNode } from "react";

const ADMIN_NAV_LINKS = [
  { href: "/admin/analytics", label: "Analytics" },
  { href: "/admin/flagged-comments", label: "Flagged Comments" },
  { href: "/admin/flagged-sources", label: "Flagged Sources" },
  { href: "/admin/dmca-cases", label: "DMCA Cases" },
  { href: "/admin/beta-requests", label: "Beta Requests" },
] as const;

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await fetchBackendSession();
  if (!session?.user?.roles?.includes("admin")) {
    redirect("/");
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50 px-4 py-8 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="mb-2 flex items-center justify-between">
          <Link
            href="/"
            className="text-sm text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
          >
            ← Back to Home
          </Link>
          <div className="flex items-center gap-4">
            {ADMIN_NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm text-cyan-700 hover:text-cyan-900 dark:text-cyan-300 dark:hover:text-cyan-100"
              >
                {link.label}
              </Link>
            ))}
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
