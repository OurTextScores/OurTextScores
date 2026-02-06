"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import type { ProjectRow } from "../../lib/api";
import {
  createInternalSourceFromRowAction,
  createProjectRowAction,
  deleteProjectRowAction,
  updateProjectRowAction
} from "../actions";

type EditableRow = ProjectRow & {
  _dirty?: boolean;
};

function trimOrUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export default function ProjectRowsTable({
  projectId,
  rows,
  canEditRows,
  canToggleVerified
}: {
  projectId: string;
  rows: ProjectRow[];
  canEditRows: boolean;
  canToggleVerified: boolean;
}) {
  const [localRows, setLocalRows] = useState<EditableRow[]>(rows);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [activeRowId, setActiveRowId] = useState<string | null>(null);

  const sortedRows = useMemo(() => [...localRows], [localRows]);

  const updateLocal = (rowId: string, patch: Partial<EditableRow>) => {
    setLocalRows((prev) => prev.map((row) => (row.rowId === rowId ? { ...row, ...patch, _dirty: true } : row)));
  };

  const saveRow = (row: EditableRow) => {
    if (!canEditRows) return;
    setError(null);
    setActiveRowId(row.rowId);
    startTransition(async () => {
      try {
        const updated = await updateProjectRowAction(projectId, row.rowId, {
          rowVersion: row.rowVersion,
          externalScoreUrl: trimOrUndefined(row.externalScoreUrl || ""),
          imslpUrl: trimOrUndefined(row.imslpUrl || ""),
          hasReferencePdf: row.hasReferencePdf,
          verified: row.verified,
          notes: row.notes || ""
        });
        setLocalRows((prev) => prev.map((candidate) => (candidate.rowId === row.rowId ? { ...(updated as ProjectRow), _dirty: false } : candidate)));
      } catch (err: any) {
        setError(err.message || "Failed to save row");
      } finally {
        setActiveRowId(null);
      }
    });
  };

  const addRow = () => {
    if (!canEditRows) return;
    setError(null);
    startTransition(async () => {
      try {
        const created = await createProjectRowAction(projectId, {
          externalScoreUrl: "",
          imslpUrl: "",
          hasReferencePdf: false,
          notes: ""
        });
        setLocalRows((prev) => [...prev, created as ProjectRow]);
      } catch (err: any) {
        setError(err.message || "Failed to add row");
      }
    });
  };

  const deleteRow = (row: EditableRow) => {
    if (!canEditRows) return;
    setError(null);
    startTransition(async () => {
      try {
        await deleteProjectRowAction(projectId, row.rowId);
        setLocalRows((prev) => prev.filter((candidate) => candidate.rowId !== row.rowId));
      } catch (err: any) {
        setError(err.message || "Failed to delete row");
      }
    });
  };

  const createSource = (row: EditableRow) => {
    if (!canEditRows) return;
    setError(null);
    setActiveRowId(row.rowId);
    startTransition(async () => {
      try {
        const result = await createInternalSourceFromRowAction(projectId, row.rowId, {
          imslpUrl: trimOrUndefined(row.imslpUrl || "")
        });
        setLocalRows((prev) =>
          prev.map((candidate) =>
            candidate.rowId === row.rowId
              ? {
                  ...candidate,
                  linkedWorkId: result.workId,
                  linkedSourceId: result.sourceId,
                  rowVersion: result.row?.rowVersion ?? candidate.rowVersion
                }
              : candidate
          )
        );
      } catch (err: any) {
        setError(err.message || "Failed to create internal source");
      } finally {
        setActiveRowId(null);
      }
    });
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/50">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Source Rows</h2>
        {canEditRows && (
          <button
            onClick={addRow}
            disabled={isPending}
            className="rounded border border-cyan-300 bg-cyan-50 px-3 py-1.5 text-xs font-semibold text-cyan-700 transition hover:bg-cyan-100 disabled:opacity-50 dark:border-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-200"
          >
            Add Row
          </button>
        )}
      </div>

      {error && (
        <p className="mb-3 rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-900/40 dark:text-rose-200">
          {error}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-[1200px] w-full divide-y divide-slate-200 text-sm dark:divide-slate-800">
          <thead className="bg-slate-100/70 text-left text-xs uppercase tracking-wide text-slate-600 dark:bg-slate-900 dark:text-slate-400">
            <tr>
              <th className="px-2 py-2">External Score</th>
              <th className="px-2 py-2">IMSLP</th>
              <th className="px-2 py-2">Internal Source</th>
              <th className="px-2 py-2">Reference PDF</th>
              <th className="px-2 py-2">Verified</th>
              <th className="px-2 py-2">Notes</th>
              <th className="px-2 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
            {sortedRows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-2 py-6 text-center text-slate-500 dark:text-slate-400">
                  No rows yet.
                </td>
              </tr>
            )}
            {sortedRows.map((row) => (
              <tr key={row.rowId} className="align-top">
                <td className="px-2 py-2">
                  <input
                    value={row.externalScoreUrl || ""}
                    disabled={!canEditRows}
                    onChange={(e) => updateLocal(row.rowId, { externalScoreUrl: e.target.value })}
                    placeholder="https://..."
                    className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                  />
                </td>
                <td className="px-2 py-2">
                  <input
                    value={row.imslpUrl || ""}
                    disabled={!canEditRows}
                    onChange={(e) => updateLocal(row.rowId, { imslpUrl: e.target.value })}
                    placeholder="https://imslp.org/wiki/..."
                    className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                  />
                </td>
                <td className="px-2 py-2">
                  {row.linkedWorkId && row.linkedSourceId ? (
                    <Link
                      href={`/works/${encodeURIComponent(row.linkedWorkId)}?source=${encodeURIComponent(row.linkedSourceId)}`}
                      className="text-xs font-semibold text-cyan-700 hover:underline dark:text-cyan-300"
                    >
                      Open Source
                    </Link>
                  ) : (
                    <button
                      onClick={() => createSource(row)}
                      disabled={!canEditRows || isPending}
                      className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                    >
                      {activeRowId === row.rowId && isPending ? "Creating..." : "Create Internal Source"}
                    </button>
                  )}
                </td>
                <td className="px-2 py-2 text-center">
                  <input
                    type="checkbox"
                    checked={!!row.hasReferencePdf}
                    disabled={!canEditRows}
                    onChange={(e) => updateLocal(row.rowId, { hasReferencePdf: e.target.checked })}
                  />
                </td>
                <td className="px-2 py-2 text-center">
                  <input
                    type="checkbox"
                    checked={!!row.verified}
                    disabled={!canToggleVerified && !canEditRows}
                    onChange={(e) => updateLocal(row.rowId, { verified: e.target.checked })}
                  />
                </td>
                <td className="px-2 py-2">
                  <textarea
                    value={row.notes || ""}
                    disabled={!canEditRows}
                    onChange={(e) => updateLocal(row.rowId, { notes: e.target.value })}
                    rows={3}
                    className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                  />
                </td>
                <td className="px-2 py-2">
                  <div className="flex gap-2">
                    <button
                      onClick={() => saveRow(row)}
                      disabled={!canEditRows || isPending || !row._dirty}
                      className="rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => deleteRow(row)}
                      disabled={!canEditRows || isPending}
                      className="rounded border border-rose-300 bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-700 transition hover:bg-rose-100 disabled:opacity-50 dark:border-rose-700 dark:bg-rose-900/30 dark:text-rose-200"
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
