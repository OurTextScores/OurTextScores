"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export default function RefreshImslpButton({ workId }: { workId: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const onClick = () => {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/proxy/imslp/works/${encodeURIComponent(workId)}/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        if (!res.ok) {
          const body = await res.text();
          throw new Error(body || `Refresh failed (${res.status})`);
        }
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  };

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={onClick}
        className="rounded border border-slate-300 bg-white px-3 py-1 text-sm font-medium text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
        disabled={isPending}
      >
        {isPending ? "Refreshing…" : "Refresh IMSLP metadata"}
      </button>
      {error && <span className="text-xs text-rose-600 dark:text-rose-300">{error}</span>}
    </div>
  );
}
