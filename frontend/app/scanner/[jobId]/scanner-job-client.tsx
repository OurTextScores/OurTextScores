"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import PageReview from "./page-review";
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

type ScannerPage = ScannerJob["pages"][number];

function plannedEngineIds(job: ScannerJob, page?: ScannerPage): string[] {
  return job.enginePlan?.engineIds || Object.keys(page?.engines || {});
}

function engineLabel(job: ScannerJob, engineId?: string): string {
  if (!engineId) return "recognition engine";
  return job.enginePlan?.capabilitySnapshots[engineId]?.displayName || engineId;
}

function selectedRawEngineId(
  job: ScannerJob,
  page?: ScannerPage,
): string | undefined {
  if (!page) return undefined;
  if (page.effectiveEngineId) return page.effectiveEngineId;
  return plannedEngineIds(job, page).find((engineId) => {
    const run = page.engines?.[engineId];
    return run?.status === "succeeded" && run.hasMusicXml;
  });
}

export default function ScannerJobClient({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [job, setJob] = useState<ScannerJob | null>(null);
  const [selectedPage, setSelectedPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [draftPages, setDraftPages] = useState<ScannerJob["pages"]>([]);
  const [pageSetupDirty, setPageSetupDirty] = useState(false);
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

  useEffect(() => {
    if (job?.status !== "ready" || pageSetupDirty) return;
    setDraftPages(
      [...job.pages].sort((left, right) => left.ordinal - right.ordinal),
    );
  }, [job, pageSetupDirty]);

  const artifactUrl = useCallback(
    (kind: "musicxml" | "pdf" | "thumbnail" | "zip", pageNumber?: number) =>
      `${base}/artifacts/${kind}${pageNumber ? `?page=${pageNumber}` : ""}`,
    [base],
  );

  const editorUrl = (pageNumber?: number) => {
    const scoreUrl = artifactUrl("musicxml", pageNumber);
    const displayPage = job?.pages.find(
      (page) => page.pageNumber === pageNumber,
    )?.ordinal;
    const params = new URLSearchParams({
      score: scoreUrl,
      launchContext: JSON.stringify({
        source: "scanner",
        sourceLabel: pageNumber
          ? `${job?.originalFilename} — page ${displayPage || pageNumber}`
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

  function updateDraft(
    pageNumber: number,
    update: (page: ScannerJob["pages"][number]) => ScannerJob["pages"][number],
  ) {
    setDraftPages((current) =>
      current.map((page) =>
        page.pageNumber === pageNumber ? update(page) : page,
      ),
    );
    setPageSetupDirty(true);
  }

  function moveDraft(pageNumber: number, direction: -1 | 1) {
    setDraftPages((current) => {
      const pages = [...current];
      const index = pages.findIndex((page) => page.pageNumber === pageNumber);
      const destination = index + direction;
      if (index < 0 || destination < 0 || destination >= pages.length)
        return current;
      [pages[index], pages[destination]] = [pages[destination], pages[index]];
      return pages.map((page, pageIndex) => ({
        ...page,
        ordinal: pageIndex + 1,
      }));
    });
    setPageSetupDirty(true);
  }

  async function savePageSetup(start: boolean) {
    const action = start ? "start" : "save-pages";
    setBusyAction(action);
    setError(null);
    try {
      const configureResponse = await fetch(`${base}/pages`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pages: draftPages.map(
            ({ pageNumber, ordinal, rotationDegrees, included }) => ({
              pageNumber,
              ordinal,
              rotationDegrees,
              included,
            }),
          ),
        }),
      });
      if (!configureResponse.ok)
        throw new Error(
          await responseError(configureResponse, "Unable to save page setup"),
        );
      const configured: ScannerJob = await configureResponse.json();
      setPageSetupDirty(false);
      if (!start) {
        setJob(configured);
        return;
      }
      const startResponse = await fetch(`${base}/start`, { method: "POST" });
      if (!startResponse.ok)
        throw new Error(
          await responseError(startResponse, "Unable to start scanning"),
        );
      setJob(await startResponse.json());
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
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
  const reviewing = job.status === "ready";
  const completedPages = job.pages.filter(
    (page) => page.status === "succeeded",
  ).length;
  const engineIds = plannedEngineIds(job, selected);
  const primaryEngineId = job.enginePlan?.primaryEngineId || engineIds[0];
  const effectiveEngineId = selectedRawEngineId(job, selected);
  const primaryRun = primaryEngineId
    ? selected?.engines?.[primaryEngineId]
    : undefined;
  const fallbackUsed = Boolean(
    primaryEngineId &&
    effectiveEngineId &&
    primaryEngineId !== effectiveEngineId &&
    primaryRun?.status === "failed",
  );
  const primaryLabel = engineLabel(job, primaryEngineId);
  const effectiveLabel = engineLabel(job, effectiveEngineId);
  const incompleteRuns = Object.entries(selected?.engines || {}).filter(
    ([, run]) =>
      run?.status === "succeeded" &&
      (run.generation?.truncated ||
        run.completeness === "possibly-incomplete" ||
        run.completeness === "incomplete"),
  );
  const effectiveLimitations = effectiveEngineId
    ? job.enginePlan?.capabilitySnapshots[effectiveEngineId]
        ?.unsupportedSemanticClasses || []
    : [];
  const supportsSpotReview = engineIds.some((engineId) => {
    const run = selected?.engines?.[engineId];
    const capability = job.enginePlan?.capabilitySnapshots[engineId];
    return run?.status === "succeeded" && capability?.supportsSpotReview;
  });

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
              {completedPages}/{job.includedPageCount} included pages complete ·{" "}
              {scannerStatusLabel(job.status)}
            </p>
          </div>
          {active || reviewing ? (
            <button
              type="button"
              disabled={Boolean(busyAction)}
              onClick={() => void runAction("cancel", `${base}/cancel`)}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              {busyAction === "cancel"
                ? "Cancelling…"
                : reviewing
                  ? "Cancel draft"
                  : "Cancel"}
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
            aria-valuemax={job.includedPageCount}
            aria-valuenow={completedPages}
          >
            <div
              className="h-full bg-blue-600 transition-all"
              style={{
                width: `${Math.max(5, (completedPages / job.includedPageCount) * 100)}%`,
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

      {reviewing ? (
        <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                Review pages before scanning
              </h2>
              <p className="mt-1 max-w-3xl text-sm text-slate-500">
                Put pages in score order, rotate sideways pages, and exclude
                covers or blanks. Provider usage does not begin until you start.
              </p>
            </div>
            <p className="text-sm text-slate-500" aria-live="polite">
              {draftPages.filter((page) => page.included).length} of{" "}
              {draftPages.length} pages included
            </p>
          </div>
          <ol className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {draftPages.map((page, index) => (
              <li
                key={page.pageNumber}
                className={`rounded-lg border p-3 ${page.included ? "border-slate-200 dark:border-slate-700" : "border-slate-200 bg-slate-50 opacity-70 dark:border-slate-800 dark:bg-slate-950"}`}
              >
                <div className="flex h-48 items-center justify-center overflow-hidden rounded-md bg-slate-100 dark:bg-slate-800">
                  {page.hasThumbnail ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={artifactUrl("thumbnail", page.pageNumber)}
                      alt={`Source page ${page.pageNumber}`}
                      className="h-full w-full bg-white object-contain transition-transform"
                      style={{
                        transform: `rotate(${page.rotationDegrees}deg)`,
                      }}
                    />
                  ) : (
                    <span className="text-xs text-slate-400">No preview</span>
                  )}
                </div>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold">Page {index + 1}</p>
                    <p className="text-xs text-slate-500">
                      Source page {page.pageNumber}
                    </p>
                  </div>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={page.included}
                      onChange={(event) =>
                        updateDraft(page.pageNumber, (current) => ({
                          ...current,
                          included: event.target.checked,
                        }))
                      }
                    />
                    Include
                  </label>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      updateDraft(page.pageNumber, (current) => ({
                        ...current,
                        rotationDegrees: ((current.rotationDegrees + 270) %
                          360) as ScannerJob["pages"][number]["rotationDegrees"],
                      }))
                    }
                    className="rounded-md border border-slate-300 px-2 py-1.5 text-xs dark:border-slate-700"
                    aria-label={`Rotate source page ${page.pageNumber} left`}
                  >
                    Rotate left
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      updateDraft(page.pageNumber, (current) => ({
                        ...current,
                        rotationDegrees: ((current.rotationDegrees + 90) %
                          360) as ScannerJob["pages"][number]["rotationDegrees"],
                      }))
                    }
                    className="rounded-md border border-slate-300 px-2 py-1.5 text-xs dark:border-slate-700"
                    aria-label={`Rotate source page ${page.pageNumber} right`}
                  >
                    Rotate right
                  </button>
                  <button
                    type="button"
                    disabled={index === 0}
                    onClick={() => moveDraft(page.pageNumber, -1)}
                    className="rounded-md border border-slate-300 px-2 py-1.5 text-xs disabled:opacity-40 dark:border-slate-700"
                    aria-label={`Move source page ${page.pageNumber} earlier`}
                  >
                    Move earlier
                  </button>
                  <button
                    type="button"
                    disabled={index === draftPages.length - 1}
                    onClick={() => moveDraft(page.pageNumber, 1)}
                    className="rounded-md border border-slate-300 px-2 py-1.5 text-xs disabled:opacity-40 dark:border-slate-700"
                    aria-label={`Move source page ${page.pageNumber} later`}
                  >
                    Move later
                  </button>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-5 flex flex-wrap justify-end gap-3 border-t border-slate-200 pt-5 dark:border-slate-800">
            <button
              type="button"
              disabled={
                Boolean(busyAction) ||
                !pageSetupDirty ||
                !draftPages.some((page) => page.included)
              }
              onClick={() => void savePageSetup(false)}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm disabled:opacity-50 dark:border-slate-700"
            >
              {busyAction === "save-pages" ? "Saving…" : "Save page setup"}
            </button>
            <button
              type="button"
              disabled={
                Boolean(busyAction) || !draftPages.some((page) => page.included)
              }
              onClick={() => void savePageSetup(true)}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busyAction === "start" ? "Starting…" : "Start scanning"}
            </button>
          </div>
        </section>
      ) : (
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
                    style={{ transform: `rotate(${page.rotationDegrees}deg)` }}
                  />
                ) : (
                  <span className="flex h-24 items-center justify-center bg-slate-100 text-xs text-slate-400 dark:bg-slate-800">
                    No preview
                  </span>
                )}
                <span className="block px-2 py-2 text-xs font-medium">
                  Page {page.ordinal}
                </span>
                {page.ordinal !== page.pageNumber && (
                  <span className="block px-2 pb-1 text-[11px] text-slate-500">
                    Source {page.pageNumber}
                  </span>
                )}
                <span className="block px-2 pb-2 text-[11px] capitalize text-slate-500">
                  {scannerStatusLabel(page.status)}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {selected && !reviewing && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                Page {selected.ordinal}
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
                      ? fallbackUsed
                        ? `Retry ${primaryLabel}`
                        : "Retry PDF render"
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
          {fallbackUsed && (
            <p className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              {primaryLabel} failed for this page, so the available MusicXML
              comes from {effectiveLabel}.{" "}
              {primaryRun?.errorMessage || selected.errorMessage}
            </p>
          )}
          {!fallbackUsed && selected.errorMessage && (
            <p className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              {selected.errorMessage}
            </p>
          )}
          {incompleteRuns.map(([engineId, run]) => (
            <p
              key={`incomplete-${engineId}`}
              className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
            >
              {run?.generation?.truncated
                ? `${engineLabel(job, engineId)} reached its generation limit, so its transcription may be incomplete.`
                : `${engineLabel(job, engineId)} reported that its transcription ${run?.completeness === "incomplete" ? "is incomplete" : "may be incomplete"}.`}
            </p>
          ))}
          {effectiveLimitations.length > 0 && (
            <p className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              {effectiveLabel} does not recognize{" "}
              {effectiveLimitations.join(", ")}; verify those details against
              the source image.
            </p>
          )}
          {selected.status === "succeeded" && supportsSpotReview && (
            <div className="mt-4">
              <PageReview jobId={jobId} pageNumber={selected.pageNumber} />
            </div>
          )}
          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <div className="flex min-h-[420px] items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-950">
              {selected.hasThumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={artifactUrl("thumbnail", selected.pageNumber)}
                  alt={`Source preview for page ${selected.pageNumber}`}
                  className="max-h-[70vh] w-full object-contain"
                  style={{
                    transform: `rotate(${selected.rotationDegrees}deg)`,
                  }}
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
            {(job.pageCount === 1 || job.hasCombinedMusicXml) &&
              job.hasMusicXml && (
                <a
                  href={artifactUrl("musicxml")}
                  download
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm dark:border-slate-700"
                >
                  {job.hasCombinedMusicXml
                    ? "Download combined MusicXML"
                    : "Download MusicXML"}
                </a>
              )}
            {job.hasCombinedMusicXml && (
              <a
                href={editorUrl()}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm dark:border-slate-700"
              >
                Open combined score in Score Editor
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
          {job.hasCombinedMusicXml ? (
            <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              Page assembly is in beta. Measure numbering is made continuous and
              page breaks are preserved, but ties, slurs, and lyrics that cross
              a page boundary are not reconstructed. The per-page files remain
              authoritative.
            </p>
          ) : job.mergeStatus === "incompatible" ||
            job.mergeStatus === "failed" ? (
            <p className="mt-4 text-xs text-slate-500">
              The pages were not combined
              {job.mergeReason ? `: ${job.mergeReason}` : ""}. Every page file
              below is complete and unaffected.
            </p>
          ) : null}
          <p className="mt-4 text-xs text-slate-500">
            Results expire {new Date(job.resultExpiresAt).toLocaleString()}.
            {!job.hasCombinedMusicXml &&
              " The ZIP preserves independent page files."}{" "}
            Results are not added to the catalogue automatically.
          </p>
        </section>
      )}

      {!active && !reviewing && !job.hasMusicXml && (
        <p className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-slate-500 dark:border-slate-700">
          No MusicXML result is available for this job.
        </p>
      )}
    </div>
  );
}
