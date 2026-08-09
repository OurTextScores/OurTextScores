"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
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

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * `fetch` reports nothing about request-body progress, so a 25 MB upload is a
 * silent wait. XMLHttpRequest still exposes upload progress events, which is
 * the only way to show real bytes-sent for the browser-to-OTS leg.
 */
function uploadJob(
  body: FormData,
  onProgress: (sent: number, total: number) => void,
): Promise<{ ok: boolean; status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/proxy/scanner/jobs");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    request.onload = () =>
      resolve({
        ok: request.status >= 200 && request.status < 300,
        status: request.status,
        body: request.responseText,
      });
    request.onerror = () =>
      reject(new Error("The upload could not be completed"));
    request.onabort = () => reject(new Error("The upload was cancelled"));
    request.send(body);
  });
}

function uploadSelectionError(files: File[]): string | null {
  if (files.length > 20) return "Select at most 20 image pages.";
  if (
    files.length > 1 &&
    files.some(
      (file) =>
        file.type === "application/pdf" ||
        file.name.toLowerCase().endsWith(".pdf"),
    )
  ) {
    return "Upload one PDF by itself, or upload only PNG/JPEG images.";
  }
  if (files.reduce((sum, file) => sum + file.size, 0) > 25 * 1024 * 1024) {
    return "The combined upload may not exceed 25 MB.";
  }
  return null;
}

export default function ScannerClient() {
  const [jobs, setJobs] = useState<ScannerJob[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [detectTitle, setDetectTitle] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Design section 13.5: the UI must not claim Scanner is available just
  // because the build-time public flag is on. NEXT_PUBLIC_* is inlined when the
  // image is built, so it can outlive the backend actually being enabled.
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [sentBytes, setSentBytes] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const abortUpload = useRef<(() => void) | null>(null);
  const router = useRouter();
  const selectionError = uploadSelectionError(files);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const percent =
    totalBytes > 0
      ? Math.min(100, Math.round((sentBytes / totalBytes) * 100))
      : 0;

  // A byte counter alone stalls at 100% while the server stores the upload, so
  // pair it with elapsed time to show the request is still alive.
  useEffect(() => {
    if (!submitting) return;
    const startedAt = Date.now();
    setElapsedMs(0);
    const timer = window.setInterval(
      () => setElapsedMs(Date.now() - startedAt),
      200,
    );
    return () => window.clearInterval(timer);
  }, [submitting]);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/proxy/scanner/jobs?limit=20", {
      cache: "no-store",
    });
    if (response.status === 503 || response.status === 403) {
      setUnavailable(
        response.status === 403
          ? "Your account is not on the Scanner beta allowlist."
          : "Scanner is not enabled on this deployment.",
      );
      return;
    }
    setUnavailable(null);
    if (!response.ok) throw new Error(await readError(response));
    const body = await response.json();
    // Tolerate the pre-pagination array shape so a rolling deploy where the
    // frontend leads the backend still renders Recent scans.
    setJobs(Array.isArray(body) ? body : (body.items ?? []));
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
    if (files.length === 0) return;
    if (selectionError) {
      setError(selectionError);
      return;
    }
    setSubmitting(true);
    setSentBytes(0);
    setError(null);
    try {
      const body = new FormData();
      for (const file of files) body.append("file", file);
      body.set("detectTitle", String(detectTitle));
      const response = await uploadJob(body, (sent) => setSentBytes(sent));
      if (!response.ok) {
        let message = `Request failed (${response.status})`;
        try {
          const parsed = JSON.parse(response.body);
          message = String(parsed?.message || parsed?.error || message);
        } catch {
          // Keep the status-based message for a non-JSON error body.
        }
        throw new Error(message);
      }
      const created: ScannerJob = JSON.parse(response.body);
      setJobs((current) => [created, ...current]);
      setFiles([]);
      const input = document.getElementById(
        "scanner-file",
      ) as HTMLInputElement | null;
      if (input) input.value = "";
      // Go straight to the scan. Preparation happens server-side, and the job
      // page already shows that stage and then the review step.
      router.push(`/scanner/${created.jobId}`);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setSubmitting(false);
    }
  }

  if (unavailable) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          Scanner is unavailable
        </h2>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          {unavailable}
        </p>
      </div>
    );
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
          Upload one PDF or up to 20 PNG/JPEG images. Image pages are ordered by
          filename and can be rearranged during review. The combined upload may
          be up to 25 MB.
        </p>
        <div className="mt-5 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">
            Score files
            <input
              id="scanner-file"
              type="file"
              accept="application/pdf,image/png,image/jpeg"
              multiple
              required
              onChange={(event) => {
                const selected = Array.from(event.target.files || [])
                  .map((file, index) => ({ file, index }))
                  .sort(
                    (left, right) =>
                      left.file.name.localeCompare(right.file.name, "en", {
                        numeric: true,
                        sensitivity: "base",
                      }) ||
                      left.file.name.localeCompare(right.file.name, "en") ||
                      left.index - right.index,
                  )
                  .map(({ file }) => file);
                setFiles(selected);
                setError(uploadSelectionError(selected));
              }}
              className="mt-2 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
            />
          </label>
          <button
            type="submit"
            disabled={
              files.length === 0 || Boolean(selectionError) || submitting
            }
            className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Uploading…" : "Scan"}
          </button>
        </div>
        {submitting && (
          <div
            className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-950"
            role="status"
            aria-live="polite"
          >
            <div className="flex items-baseline justify-between text-sm">
              <span className="font-medium text-slate-700 dark:text-slate-300">
                {percent < 100
                  ? "Uploading to OurTextScores…"
                  : "Upload complete — storing your pages…"}
              </span>
              <span className="tabular-nums text-xs text-slate-500 dark:text-slate-400">
                {formatBytes(sentBytes)} of {formatBytes(totalBytes)} ·{" "}
                {(elapsedMs / 1000).toFixed(1)}s
              </span>
            </div>
            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
              <div
                className={`h-full rounded-full bg-blue-600 transition-[width] duration-150 ${
                  percent >= 100 ? "animate-pulse" : ""
                }`}
                style={{ width: `${Math.max(2, percent)}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              {percent < 100
                ? `${percent}% sent. This is the upload to OurTextScores; recognition starts after you review the pages.`
                : "Your pages are being stored and prepared. You will be taken to the scan shortly."}
            </p>
          </div>
        )}
        {files.length > 1 && (
          <div className="mt-4 rounded-lg bg-slate-50 px-4 py-3 text-sm dark:bg-slate-950">
            <p className="font-medium text-slate-700 dark:text-slate-300">
              Initial page order
            </p>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-slate-600 dark:text-slate-400">
              {files.map((file, index) => (
                <li
                  key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
                >
                  {file.name}
                </li>
              ))}
            </ol>
          </div>
        )}
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
