"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  activeScannerStatuses,
  ScannerJob,
  scannerStatusLabel,
} from "./scanner-types";

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    return String(
      body?.message || body?.error || `Request failed (${response.status})`,
    );
  } catch {
    return `Request failed (${response.status})`;
  }
}

export default function ScannerClient() {
  const [jobs, setJobs] = useState<ScannerJob[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [detectTitle, setDetectTitle] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/proxy/scanner/jobs", {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(await readError(response));
    setJobs(await response.json());
  }, []);

  useEffect(() => {
    refresh()
      .catch((value) =>
        setError(value instanceof Error ? value.message : String(value)),
      )
      .finally(() => setLoading(false));
  }, [refresh]);

  useEffect(() => {
    if (!jobs.some((job) => activeScannerStatuses.includes(job.status))) return;
    const timer = window.setInterval(
      () => void refresh().catch(() => undefined),
      3_000,
    );
    return () => window.clearInterval(timer);
  }, [jobs, refresh]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setSubmitting(true);
    setError(null);
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("detectTitle", String(detectTitle));
      const response = await fetch("/api/proxy/scanner/jobs", {
        method: "POST",
        body,
      });
      if (!response.ok) throw new Error(await readError(response));
      const created: ScannerJob = await response.json();
      setJobs((current) => [created, ...current]);
      setFile(null);
      const input = document.getElementById(
        "scanner-file",
      ) as HTMLInputElement | null;
      if (input) input.value = "";
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-8">
      <form
        onSubmit={submit}
        className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900"
      >
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          Scan a score
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Upload a PDF, PNG, or JPEG. PDFs may contain up to 20 pages; files may
          be up to 25 MB.
        </p>
        <div className="mt-5 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">
            Score file
            <input
              id="scanner-file"
              type="file"
              accept="application/pdf,image/png,image/jpeg"
              required
              onChange={(event) => setFile(event.target.files?.[0] || null)}
              className="mt-2 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
            />
          </label>
          <button
            type="submit"
            disabled={!file || submitting}
            className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Uploading…" : "Upload and review"}
          </button>
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          <input
            type="checkbox"
            checked={detectTitle}
            onChange={(event) => setDetectTitle(event.target.checked)}
          />
          Attempt title detection
        </label>
      </form>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200"
        >
          {error}
        </div>
      )}

      <section>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          Recent scans
        </h2>
        {loading ? (
          <p className="mt-3 text-sm text-slate-500">Loading…</p>
        ) : jobs.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700">
            No scans yet.
          </p>
        ) : (
          <div className="mt-3 divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
            {jobs.map((job) => (
              <Link
                key={job.jobId}
                href={`/scanner/${encodeURIComponent(job.jobId)}`}
                className="flex items-center justify-between gap-4 p-4 hover:bg-slate-50 dark:hover:bg-slate-800/60"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-900 dark:text-slate-100">
                    {job.originalFilename}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {job.pageCount} {job.pageCount === 1 ? "page" : "pages"} ·{" "}
                    {new Date(job.createdAt).toLocaleString()}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-slate-100 px-3 py-1 text-xs font-medium capitalize text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                  {scannerStatusLabel(job.status)}
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
