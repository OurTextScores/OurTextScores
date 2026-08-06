"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  activeScannerStatuses,
  ScannerJob,
  scannerStatusLabel
} from "../scanner-types";

export default function ScannerJobClient({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [job, setJob] = useState<ScannerJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/api/proxy/scanner/jobs/${encodeURIComponent(jobId)}`;

  const refresh = useCallback(async () => {
    const response = await fetch(base, { cache: "no-store" });
    if (!response.ok) {
      const value = await response.json().catch(() => ({}));
      throw new Error(String(value?.message || value?.error || `Request failed (${response.status})`));
    }
    setJob(await response.json());
  }, [base]);

  useEffect(() => {
    refresh().catch((value) => setError(value instanceof Error ? value.message : String(value)));
  }, [refresh]);

  useEffect(() => {
    if (!job || !activeScannerStatuses.includes(job.status)) return;
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 3_000);
    return () => window.clearInterval(timer);
  }, [job, refresh]);

  async function cancel() {
    setBusy(true);
    try {
      const response = await fetch(`${base}/cancel`, { method: "POST" });
      if (!response.ok) throw new Error("Unable to cancel this scan");
      setJob(await response.json());
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm("Delete this scan and all retained files?")) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(base, { method: "DELETE" });
      if (!response.ok) throw new Error("Unable to delete this scan");
      router.push("/scanner");
      router.refresh();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setBusy(false);
    }
  }

  async function retry() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${base}/retry`, { method: "POST" });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(value?.message || "Unable to retry this scan"));
      setJob(value);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  }

  if (error) return <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">{error}</div>;
  if (!job) return <p className="text-sm text-slate-500">Loading scan…</p>;

  const active = activeScannerStatuses.includes(job.status);
  const completedPages = job.pages.filter((page) => page.status === "succeeded").length;
  const editorUrl = (pageNumber?: number) => {
    const scoreUrl = `${base}/artifacts/musicxml${pageNumber ? `?page=${pageNumber}` : ""}`;
    const params = new URLSearchParams({
      score: scoreUrl,
      launchContext: JSON.stringify({
        source: "scanner",
        sourceLabel: pageNumber ? `${job.originalFilename} — page ${pageNumber}` : job.originalFilename,
        canonicalXmlUrl: scoreUrl
      })
    });
    return `/score-editor/index.html?${params.toString()}`;
  };

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="break-all text-2xl font-bold text-slate-900 dark:text-slate-100">{job.originalFilename}</h1>
            <p className="mt-2 text-sm text-slate-500">
              {completedPages}/{job.pageCount} pages complete · {scannerStatusLabel(job.status)}
            </p>
          </div>
          {active && (
            <button
              type="button"
              disabled={busy}
              onClick={cancel}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              {busy ? "Cancelling…" : "Cancel"}
            </button>
          )}
          {!active && (
            <div className="flex gap-2">
              {job.canRetry && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={retry}
                  className="rounded-lg border border-blue-300 px-4 py-2 text-sm text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-900 dark:text-blue-300 dark:hover:bg-blue-950/40"
                >
                  {busy ? "Queuing…" : "Retry"}
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={remove}
                className="rounded-lg border border-red-300 px-4 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/40"
              >
                {busy ? "Deleting…" : "Delete scan"}
              </button>
            </div>
          )}
        </div>
        {active && (
          <div className="mt-5 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <div
              className="h-full bg-blue-600 transition-all"
              style={{ width: `${Math.max(5, (completedPages / job.pageCount) * 100)}%` }}
            />
          </div>
        )}
        {job.errorMessage && (
          <p className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            {job.errorMessage}
          </p>
        )}
      </section>

      {job.hasMusicXml && (
        <section className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Results</h2>
          <div className="mt-4 flex flex-wrap gap-3">
            <a
              href={`${base}/artifacts/musicxml`}
              download
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
            >
              Download {job.pageCount === 1 ? "MusicXML" : "MusicXML pages (.zip)"}
            </a>
            {job.pageCount === 1 && (
              <a
                href={editorUrl()}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                Open in Score Editor
              </a>
            )}
            {job.pages.length > 1 && job.pages.filter((page) => page.hasMusicXml).map((page) => (
              <span key={page.pageNumber} className="inline-flex overflow-hidden rounded-lg border border-slate-300 dark:border-slate-700">
                <a
                  href={`${base}/artifacts/musicxml?page=${page.pageNumber}`}
                  download
                  className="px-3 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  Page {page.pageNumber}
                </a>
                <a
                  href={editorUrl(page.pageNumber)}
                  target="_blank"
                  rel="noreferrer"
                  className="border-l border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                >
                  Edit
                </a>
              </span>
            ))}
          </div>
          <p className="mt-4 text-xs text-slate-500">
            Results expire {new Date(job.resultExpiresAt).toLocaleDateString()}. Scanner results are not added to the catalogue automatically.
          </p>
        </section>
      )}

      {job.hasPdf && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Rendered score</h2>
            <a href={`${base}/artifacts/pdf`} target="_blank" rel="noreferrer" className="text-sm text-blue-600 hover:underline dark:text-blue-400">
              Open PDF
            </a>
          </div>
          <object
            data={`${base}/artifacts/pdf`}
            type="application/pdf"
            className="h-[75vh] min-h-[520px] w-full rounded-lg border border-slate-200 dark:border-slate-700"
          >
            <p className="p-4 text-sm">
              PDF preview is unavailable in this browser. <a className="text-blue-600 underline" href={`${base}/artifacts/pdf`}>Download it instead.</a>
            </p>
          </object>
        </section>
      )}

      {!active && !job.hasMusicXml && (
        <p className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-slate-500 dark:border-slate-700">
          No MusicXML result is available for this job.
        </p>
      )}
    </div>
  );
}
