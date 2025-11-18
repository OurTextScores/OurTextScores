"use client";

import { useState, useTransition } from "react";
import { deleteSourceAction } from "./admin-actions";

export default function DeleteSourceButton({
  workId,
  sourceId,
}: {
  workId: string;
  sourceId: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleDelete = async () => {
    setError(null);
    startTransition(async () => {
      try {
        await deleteSourceAction(workId, sourceId);
      } catch (err: any) {
        setError(err.message || "Failed to delete source");
      }
    });
  };

  return (
    <div>
      <button
        type="button"
        onClick={handleDelete}
        disabled={isPending}
        className="rounded border border-rose-500 bg-rose-50 px-3 py-1 text-xs font-semibold text-rose-700 shadow-sm transition hover:bg-rose-100 disabled:opacity-50 disabled:cursor-not-allowed dark:border-rose-500 dark:bg-rose-500/20 dark:text-rose-200 dark:hover:bg-rose-500/40"
      >
        {isPending ? "Deleting..." : "Delete source"}
      </button>
      {error && (
        <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}
    </div>
  );
}
