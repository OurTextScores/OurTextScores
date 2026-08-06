"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  activeScannerStatuses,
  ScannerJob,
  scannerStatusLabel,
} from "../scanner-types";

async function responseError(
  response: Response,
  fallback: string,
): Promise<string> {
  const value = await response.json().catch(() => ({}));
  return String(value?.message || value?.error || fallback);
}

export default function ScannerJobClient({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [job, setJob] = useState<ScannerJob | null>(null);
  const [selectedPage, setSelectedPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const base = `/api/proxy/scanner/jobs/${encodeURIComponent(jobId)}`;

  const refresh = useCallback(async () => {
    const response = await fetch(base, { cache: "no-store" });
    if (!response.ok)
      throw new Error(
        await responseError(response, `Request failed (${response.status})`),
      );
    setJob(await response.json());
  }, [base]);

  useEffect(() => {
    refresh().catch((value) =>
      setError(value instanceof Error ? value.message : String(value)),
    );
  }, [refresh]);

  useEffect(() => {
    if (!job || !activeScannerStatuses.includes(job.status)) return;
    const timer = window.setInterval(
      () => void refresh().catch(() => undefined),
      2_000,
    );
    return () => window.clearInterval(timer);
  }, [job, refresh]);

  useEffect(() => {
    if (!job?.pages.length) return;
    if (!job.pages.some((page) => page.pageNumber === selectedPage)) {
      setSelectedPage(job.pages[0].pageNumber);
    }
  }, [job, selectedPage]);

  const artifactUrl = useCallback(
    (kind: "musicxml" | "pdf" | "thumbnail" | "zip", pageNumber?: number) =>
      `${base}/artifacts/${kind}${pageNumber ? `?page=${pageNumber}` : ""}`,
    [base],
  );

  const editorUrl = (pageNumber?: number) => {
    const scoreUrl = artifactUrl("musicxml", pageNumber);
    const params = new URLSearchParams({
      score: scoreUrl,
      launchContext: JSON.stringify({
        source: "scanner",
        sourceLabel: pageNumber
          ? `${job?.originalFilename} — page ${pageNumber}`
          : job?.originalFilename,
        canonicalXmlUrl: scoreUrl,
      }),
    });
    return `/score-editor/index.html?${params.toString()}`;
  };

  async function runAction(action: string, url: string) {
    setBusyAction(action);
    setError(null);
    try {
      const response = await fetch(url, { method: "POST" });
      if (!response.ok)
        throw new Error(
          await responseError(response, "Unable to update this scan"),
        );
      setJob(await response.json());
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusyAction(null);
    }
  }

  async function remove() {
    if (!window.confirm("Delete this scan and all retained files?")) return;
    setBusyAction("delete");
    setError(null);
    try {
      const response = await fetch(base, { method: "DELETE" });
      if (!response.ok)
        throw new Error(
          await responseError(response, "Unable to delete this scan"),
        );
      router.push("/scanner");
      router.refresh();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setBusyAction(null);
    }
  }

  const selected = useMemo(
    () => job?.pages.find((page) => page.pageNumber === selectedPage),
    [job, selectedPage],
  );

  if (!job) {
    return error ? (
      <div
        role="alert"
        className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800"
      >
        {error}
      </div>
    ) : (
      <p className="text-sm text-slate-500">Loading scan…</p>
    );
  }

  const active = activeScannerStatuses.includes(job.status);
  const completedPages = job.pages.filter(
    (page) => page.status === "succeeded",
  ).length;

  return (
    <div className="space-y-6">
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200"
        >
          {error}
        </div>
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="break-all text-2xl font-bold text-slate-900 dark:text-slate-100">
              {job.originalFilename}
            </h1>
            <p className="mt-2 text-sm text-slate-500" aria-live="polite">
              {completedPages}/{job.pageCount} pages complete ·{" "}
              {scannerStatusLabel(job.status)}
            </p>
          </div>
          {active ? (
            <button
              type="button"
              disabled={Boolean(busyAction)}
              onClick={() => void runAction("cancel", `${base}/cancel`)}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              {busyAction === "cancel" ? "Cancelling…" : "Cancel"}
            </button>
          ) : (
            <div className="flex flex-wrap gap-2">
              {job.canRetry && (
                <button
                  type="button"
                  disabled={Boolean(busyAction)}
                  onClick={() => void runAction("retry-all", `${base}/retry`)}
                  className="rounded-lg border border-blue-300 px-4 py-2 text-sm text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-900 dark:text-blue-300 dark:hover:bg-blue-950/40"
                >
                  {busyAction === "retry-all"
                    ? "Queuing…"
                    : "Retry eligible pages"}
                </button>
              )}
              <button
                type="button"
                disabled={Boolean(busyAction)}
                onClick={() => void remove()}
                className="rounded-lg border border-red-300 px-4 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/40"
              >
                {busyAction === "delete" ? "Deleting…" : "Delete scan"}
              </button>
            </div>
          )}
        </div>
        {active && (
          <div
            className="mt-5 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={job.pageCount}
            aria-valuenow={completedPages}
          >
            <div
              className="h-full bg-blue-600 transition-all"
              style={{
                width: `${Math.max(5, (completedPages / job.pageCount) * 100)}%`,
              }}
            />
          </div>
        )}
        {job.errorMessage && (
          <p className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            {job.errorMessage}
          </p>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap gap-3" aria-label="Scan pages">
          {job.pages.map((page) => (
            <button
              type="button"
              key={page.pageNumber}
              onClick={() => setSelectedPage(page.pageNumber)}
              aria-pressed={selectedPage === page.pageNumber}
              className={`w-24 overflow-hidden rounded-lg border text-left transition ${selectedPage === page.pageNumber ? "border-blue-500 ring-2 ring-blue-200 dark:ring-blue-900" : "border-slate-200 dark:border-slate-700"}`}
            >
              {page.hasThumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={artifactUrl("thumbnail", page.pageNumber)}
                  alt=""
                  className="h-24 w-full bg-white object-contain"
                />
              ) : (
                <span className="flex h-24 items-center justify-center bg-slate-100 text-xs text-slate-400 dark:bg-slate-800">
                  No preview
                </span>
              )}
              <span className="block px-2 py-2 text-xs font-medium">
                Page {page.pageNumber}
              </span>
              <span className="block px-2 pb-2 text-[11px] capitalize text-slate-500">
                {scannerStatusLabel(page.status)}
              </span>
            </button>
          ))}
        </div>
      </section>

      {selected && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                Page {selected.pageNumber}
              </h2>
              <p className="text-sm text-slate-500">
                {scannerStatusLabel(selected.status)} · {selected.attempts}{" "}
                provider {selected.attempts === 1 ? "attempt" : "attempts"}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {selected.canRetry && !active && (
                <button
                  type="button"
                  disabled={Boolean(busyAction)}
                  onClick={() =>
                    void runAction(
                      `retry-${selected.pageNumber}`,
                      `${base}/pages/${selected.pageNumber}/retry`,
                    )
                  }
                  className="rounded-lg border border-blue-300 px-3 py-2 text-sm text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-900 dark:text-blue-300"
                >
                  {busyAction === `retry-${selected.pageNumber}`
                    ? "Queuing…"
                    : selected.hasMusicXml
                      ? "Retry PDF render"
                      : "Retry page"}
                </button>
              )}
              {selected.hasMusicXml && (
                <a
                  href={artifactUrl("musicxml", selected.pageNumber)}
                  download
                  className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700"
                >
                  Download MusicXML
                </a>
              )}
              {selected.hasPdf && (
                <a
                  href={artifactUrl("pdf", selected.pageNumber)}
                  download
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700"
                >
                  Download PDF
                </a>
              )}
              {selected.hasMusicXml && (
                <a
                  href={editorUrl(selected.pageNumber)}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700"
                >
                  Open in Score Editor
                </a>
              )}
            </div>
          </div>
          {selected.errorMessage && (
            <p className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              {selected.errorMessage}
            </p>
          )}
          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <div className="flex min-h-[420px] items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-950">
              {selected.hasThumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={artifactUrl("thumbnail", selected.pageNumber)}
                  alt={`Source preview for page ${selected.pageNumber}`}
                  className="max-h-[70vh] w-full object-contain"
                />
              ) : (
                <p className="p-5 text-sm text-slate-500">
                  Source preview is unavailable or has expired.
                </p>
              )}
            </div>
            <div className="min-h-[420px] overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
              {selected.hasPdf ? (
                <object
                  data={artifactUrl("pdf", selected.pageNumber)}
                  type="application/pdf"
                  className="h-[70vh] min-h-[420px] w-full"
                >
                  <p className="p-4 text-sm">
                    PDF preview is unavailable in this browser.{" "}
                    <a
                      className="text-blue-600 underline"
                      href={artifactUrl("pdf", selected.pageNumber)}
                    >
                      Download it instead.
                    </a>
                  </p>
                </object>
              ) : (
                <p className="flex min-h-[420px] items-center justify-center p-5 text-sm text-slate-500">
                  No rendered PDF is available for this page.
                </p>
              )}
            </div>
          </div>
        </section>
      )}

      {(job.hasMusicXml || job.hasZip) && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Job downloads
          </h2>
          <div className="mt-3 flex flex-wrap gap-3">
            {job.hasZip && (
              <a
                href={artifactUrl("zip")}
                download
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
              >
                Download all results (.zip)
              </a>
            )}
            {job.pageCount === 1 && job.hasMusicXml && (
              <a
                href={artifactUrl("musicxml")}
                download
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm dark:border-slate-700"
              >
                Download MusicXML
              </a>
            )}
            {job.hasPdf && (
              <a
                href={artifactUrl("pdf")}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm dark:border-slate-700"
              >
                Open combined PDF
              </a>
            )}
          </div>
          <p className="mt-4 text-xs text-slate-500">
            Results expire {new Date(job.resultExpiresAt).toLocaleString()}.
            Multi-page MusicXML is not assembled; the ZIP preserves independent
            page files. Results are not added to the catalogue automatically.
          </p>
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
