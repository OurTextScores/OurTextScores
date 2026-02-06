"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { ProjectSourceSummary } from "../../lib/api";
import { removeProjectSourceAction } from "../actions";

function fmt(value?: string) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

export default function ProjectSourcesTable({
  projectId,
  sources,
  total,
  limit,
  offset,
  canRemoveSources,
}: {
  projectId: string;
  sources: ProjectSourceSummary[];
  total: number;
  limit: number;
  offset: number;
  canRemoveSources: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;
  const prevOffset = Math.max(0, offset - limit);
  const nextOffset = offset + limit;

  const onRemove = (sourceId: string) => {
    setError(null);
    startTransition(async () => {
      try {
        await removeProjectSourceAction(projectId, sourceId);
      } catch (err: any) {
        setError(err?.message || "Failed to remove source from project");
      }
    });
  };

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/50">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Project Sources</h2>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {total} total
        </p>
      </div>
      {error && (
        <p className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700 dark:border-rose-800 dark:bg-rose-900/30 dark:text-rose-200">
          {error}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-800">
          <thead className="bg-slate-100/80 text-left text-xs uppercase tracking-wide text-slate-600 dark:bg-slate-900 dark:text-slate-400">
            <tr>
              <th className="px-3 py-2">Source</th>
              <th className="px-3 py-2">Work</th>
              <th className="px-3 py-2">Format</th>
              <th className="px-3 py-2">Reference PDF</th>
              <th className="px-3 py-2">Verified</th>
              <th className="px-3 py-2">Updated</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
            {sources.length === 0 && (
              <tr>
                <td className="px-3 py-6 text-center text-slate-500 dark:text-slate-400" colSpan={7}>
                  No sources linked to this project yet.
                </td>
              </tr>
            )}
            {sources.map((source) => (
              <tr key={source.sourceId} className="hover:bg-slate-50 dark:hover:bg-slate-900/70">
                <td className="px-3 py-3">
                  <Link
                    href={`/works/${encodeURIComponent(source.workId)}?source=${encodeURIComponent(source.sourceId)}`}
                    className="font-semibold text-cyan-700 hover:underline dark:text-cyan-300"
                  >
                    {source.label}
                  </Link>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{source.sourceId}</p>
                </td>
                <td className="px-3 py-3 text-slate-700 dark:text-slate-300">
                  <p>{source.title || `Work ${source.workId}`}</p>
                  {source.composer && <p className="text-xs text-slate-500 dark:text-slate-400">{source.composer}</p>}
                </td>
                <td className="px-3 py-3 text-slate-700 dark:text-slate-300">{source.format}</td>
                <td className="px-3 py-3 text-slate-700 dark:text-slate-300">{source.hasReferencePdf ? "Yes" : "No"}</td>
                <td className="px-3 py-3 text-slate-700 dark:text-slate-300">{source.adminVerified ? "Yes" : "No"}</td>
                <td className="px-3 py-3 text-slate-700 dark:text-slate-300">{fmt(source.latestRevisionAt)}</td>
                <td className="px-3 py-3">
                  {canRemoveSources ? (
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => onRemove(source.sourceId)}
                      className="rounded border border-rose-300 bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-700 transition hover:bg-rose-100 disabled:opacity-50 dark:border-rose-700 dark:bg-rose-900/30 dark:text-rose-200"
                    >
                      Remove
                    </button>
                  ) : (
                    <span className="text-xs text-slate-400">-</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-xs dark:border-slate-800">
        <span className="text-slate-500 dark:text-slate-400">
          Showing {sources.length > 0 ? offset + 1 : 0} to {Math.min(offset + sources.length, total)} of {total}
        </span>
        <div className="flex gap-2">
          {hasPrev ? (
            <Link
              href={`/projects/${encodeURIComponent(projectId)}?limit=${limit}&offset=${prevOffset}`}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              Previous
            </Link>
          ) : (
            <span className="rounded border border-slate-200 px-2 py-1 text-slate-400 dark:border-slate-800">Previous</span>
          )}
          {hasNext ? (
            <Link
              href={`/projects/${encodeURIComponent(projectId)}?limit=${limit}&offset=${nextOffset}`}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              Next
            </Link>
          ) : (
            <span className="rounded border border-slate-200 px-2 py-1 text-slate-400 dark:border-slate-800">Next</span>
          )}
        </div>
      </div>
    </section>
  );
}
