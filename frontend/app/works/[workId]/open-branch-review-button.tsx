"use client";

import { useState } from "react";

export default function OpenBranchReviewButton({
  workId,
  sourceId,
  branchName,
}: {
  workId: string;
  sourceId: string;
  branchName: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleOpenReview = async () => {
    try {
      setBusy(true);
      setError(null);
      const res = await fetch(
        `/api/proxy/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/branches/${encodeURIComponent(branchName)}/change-review`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: `CR for ${branchName}` }),
        }
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Failed to open CR (${res.status})`);
      }
      const data = await res.json();
      window.location.assign(`/change-reviews/${encodeURIComponent(data.reviewId)}`);
    } catch (err: any) {
      setError(err.message || "Failed to open change review");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => void handleOpenReview()}
        disabled={busy}
        className="rounded border border-cyan-300 bg-cyan-50 px-3 py-1 text-xs font-semibold text-cyan-700 transition hover:bg-cyan-100 disabled:opacity-50 dark:border-cyan-700 dark:bg-cyan-950/40 dark:text-cyan-300"
      >
        {busy ? "Opening CR..." : "Open CR"}
      </button>
      {error && (
        <div className="rounded border border-rose-300 bg-rose-50 px-2 py-1 text-xs text-rose-700 dark:border-rose-700 dark:bg-rose-900/50 dark:text-rose-200">
          {error}
        </div>
      )}
    </div>
  );
}
