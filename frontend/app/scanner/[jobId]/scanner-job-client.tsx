"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PageComparison from "./page-comparison";
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

const terminalEngineStatuses = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
]);

function engineRunLabel(status: ScannerEngineRunStatus): string {
  switch (status) {
    case "running":
      return "Recognizing…";
    case "succeeded":
      return "Complete";
    case "pending":
      return "Waiting";
    default:
      return scannerStatusLabel(status);
  }
}

type ScannerEngineRunStatus = NonNullable<
  NonNullable<ScannerPage["engines"]>[string]
>["status"];

function activePage(
  job: ScannerJob,
  selected?: ScannerPage,
): ScannerPage | undefined {
  return (
    job.pages.find((page) =>
      Object.values(page.engines || {}).some(
        (run) => run?.status === "running",
      ),
    ) ||
    (job.status === "rendering"
      ? job.pages.find((page) => page.hasMusicXml && !page.hasPdf)
      : undefined) ||
    selected
  );
}

function pageStageLabel(job: ScannerJob, page: ScannerPage): string {
  const running = Object.entries(page.engines || {}).find(
    ([, run]) => run?.status === "running",
  );
  if (running) return `${engineLabel(job, running[0])} recognizing`;
  if (job.status === "rendering" && page.hasMusicXml && !page.hasPdf)
    return "Rendering preview";
  const pending = plannedEngineIds(job, page).find(
    (engineId) => page.engines?.[engineId]?.status === "pending",
  );
  if (pending && activeScannerStatuses.includes(job.status))
    return `Waiting for ${engineLabel(job, pending)}`;
  return scannerStatusLabel(page.status);
}

export default function ScannerJobClient({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [job, setJob] = useState<ScannerJob | null>(null);
  const [selectedPage, setSelectedPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [draftPages, setDraftPages] = useState<ScannerJob["pages"]>([]);
  const [pageSetupDirty, setPageSetupDirty] = useState(false);
  // Which reading sits in each pane. Defaulting to scan-versus-first-engine
  // keeps the old view as the starting point; the reader can put the two
  // engines side by side, which the fixed layout could never show.
  const [previewLeft, setPreviewLeft] = useState("scan");
  const [previewRight, setPreviewRight] = useState("");
  // Advancing a page from the bottom of a long document otherwise leaves the
  // reader looking at the footer of a page they have already dealt with.
  const pageSectionRef = useRef<HTMLElement | null>(null);
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
    (
      kind: "musicxml" | "pdf" | "thumbnail" | "zip" | "kern",
      pageNumber?: number,
      engineId?: string,
    ) => {
      const query = new URLSearchParams();
      if (pageNumber) query.set("page", String(pageNumber));
      if (engineId) query.set("engine", engineId);
      const search = query.toString();
      return `${base}/artifacts/${kind}${search ? `?${search}` : ""}`;
    },
    [base],
  );

  const editorUrl = (pageNumber?: number, engineId?: string) => {
    const scoreUrl = artifactUrl("musicxml", pageNumber, engineId);
    const displayPage = job?.pages.find(
      (page) => page.pageNumber === pageNumber,
    )?.ordinal;
    // Name the engine in the label: two readings of one page are otherwise
    // indistinguishable once they are open in the editor.
    const engineSuffix =
      engineId && job ? ` — ${engineLabel(job, engineId)}` : "";
    const params = new URLSearchParams({
      score: scoreUrl,
      launchContext: JSON.stringify({
        source: "scanner",
        sourceLabel: pageNumber
          ? `${job?.originalFilename} — page ${displayPage || pageNumber}${engineSuffix}`
          : `${job?.originalFilename}${engineSuffix}`,
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
  // Before the review step, not after it: `preparing` is only ever set while a
  // freshly uploaded source is being turned into page images.
  const preparing = job.status === "preparing";
  // Never past the total: a retained job from before the counter existed
  // reports nothing, and the bar should read empty rather than full.
  const preparedPages = Math.min(
    Math.max(job.preparedPageCount || 0, 0),
    job.pageCount || 0,
  );
  const completedPages = job.pages.filter(
    (page) => page.status === "succeeded",
  ).length;
  const engineIds = plannedEngineIds(job, selected);
  const primaryEngineId = job.enginePlan?.primaryEngineId || engineIds[0];
  // What the job-level downloads are actually built from: each page's effective
  // MusicXML, which is the reconciled score wherever one exists.
  const includedPageCount = job.pages.filter((page) => page.included !== false).length;
  // Terminal, in the sense that no page is still going to change. Anything
  // offered before this describes a scan that is not finished.
  const jobFinished = ["succeeded", "partial", "failed", "cancelled"].includes(
    job.status,
  );
  // The next page a reader would work on, in the order they are shown.
  const orderedIncluded = job.pages
    .filter((page) => page.included !== false)
    .sort((left, right) => left.ordinal - right.ordinal);
  const selectedOrdinal =
    orderedIncluded.findIndex((page) => page.pageNumber === selected?.pageNumber) + 1;
  const nextIncludedPage = orderedIncluded.find(
    (page) => page.ordinal > (selected?.ordinal ?? 0),
  )?.pageNumber;
  // Once the work has been combined the reader has been through it, so going
  // back to an earlier page should not hide the button that rebuilds it.
  const pagesRemain = nextIncludedPage !== undefined && !job.hasCombinedMusicXml;
  const decidedPages = job.pages.filter((page) => page.hasMergedScore).length;
  const primaryEngineName =
    job.enginePlan?.capabilitySnapshots[primaryEngineId]?.displayName || primaryEngineId;
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
  // Every engine that produced a reading can be put in either pane.
  const previewEngineIds = engineIds.filter(
    (engineId) => selected?.engines?.[engineId]?.status === "succeeded",
  );
  // Either engine's rendering of this page, or the scan itself.
  const previewChoices = [
    { key: "scan", kind: "scan" as const, label: "Scan", pdfUrl: undefined },
    ...(previewEngineIds.length > 0
      ? previewEngineIds.map((engineId) => ({
          key: engineId,
          kind: "engine" as const,
          label: engineLabel(job, engineId),
          pdfUrl: selected?.engines?.[engineId]?.hasPdf
            ? artifactUrl("pdf", selected.pageNumber, engineId)
            : undefined,
        }))
      : [
          {
            key: "effective",
            kind: "engine" as const,
            label: effectiveLabel,
            pdfUrl: selected?.hasPdf
              ? artifactUrl("pdf", selected.pageNumber)
              : undefined,
          },
        ]),
  ];
  // A pane's choice is a preference, not a guarantee: pages differ in which
  // engines succeeded, so a key that isn't on offer here falls back rather than
  // rendering an empty pane.
  const previewFallbackRight =
    previewChoices.find((choice) => choice.kind === "engine")?.key || "scan";
  const resolvePreview = (key: string, fallback: string) =>
    previewChoices.some((choice) => choice.key === key) ? key : fallback;
  const leftPreviewKey = resolvePreview(previewLeft, "scan");
  const rightPreviewKey = resolvePreview(previewRight, previewFallbackRight);
  const supportsSpotReview = engineIds.some((engineId) => {
    const run = selected?.engines?.[engineId];
    const capability = job.enginePlan?.capabilitySnapshots[engineId];
    return run?.status === "succeeded" && capability?.supportsSpotReview;
  });
  const progressPage = activePage(job, selected);
  const progressEngineIds = progressPage
    ? plannedEngineIds(job, progressPage)
    : engineIds;
  const includedPages = job.pages.filter((page) => page.included);
  const progressMaximum = includedPages.reduce(
    (sum, page) => sum + plannedEngineIds(job, page).length + 1,
    0,
  );
  const progressValue = includedPages.reduce((sum, page) => {
    const planned = plannedEngineIds(job, page);
    const completedEngines = planned.filter((engineId) => {
      const status = page.engines?.[engineId]?.status;
      return status ? terminalEngineStatuses.has(status) : false;
    }).length;
    const allEnginesTerminal = planned.every((engineId) => {
      const status = page.engines?.[engineId]?.status;
      return status ? terminalEngineStatuses.has(status) : false;
    });
    const previewFinished =
      page.hasPdf || (allEnginesTerminal && !page.hasMusicXml);
    return sum + completedEngines + (previewFinished ? 1 : 0);
  }, 0);
  const runningEngine = progressPage
    ? Object.entries(progressPage.engines || {}).find(
        ([, run]) => run?.status === "running",
      )
    : undefined;
  const activeStage =
    job.status === "queued"
      ? "Waiting for a scanner worker…"
      : job.status === "preparing"
        ? "Preparing page images…"
        : job.status === "rendering" && progressPage
          ? `Rendering preview for page ${progressPage.ordinal}…`
          : runningEngine && progressPage
            ? `${engineLabel(job, runningEngine[0])} is recognizing page ${progressPage.ordinal} of ${job.includedPageCount}…`
            : "Finishing scan results…";

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
              {active
                ? activeStage
                : `${completedPages}/${job.includedPageCount} included pages complete · ${scannerStatusLabel(job.status)}`}
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
            aria-valuemax={progressMaximum}
            aria-valuenow={progressValue}
            aria-label="Recognition and preview progress"
          >
            <div
              className="h-full bg-blue-600 transition-all"
              style={{
                width: `${Math.max(5, (progressValue / Math.max(1, progressMaximum)) * 100)}%`,
              }}
            />
          </div>
        )}
        {active && progressPage && (
          <div className="mt-4 rounded-lg border border-slate-200 px-4 py-3 text-sm dark:border-slate-700">
            <p className="font-medium text-slate-800 dark:text-slate-200">
              Page {progressPage.ordinal}
            </p>
            <ul className="mt-2 space-y-1 text-slate-600 dark:text-slate-400">
              {progressEngineIds.map((engineId) => {
                const run = progressPage.engines?.[engineId];
                return (
                  <li key={engineId} className="flex justify-between gap-4">
                    <span>{engineLabel(job, engineId)}</span>
                    <span>{run ? engineRunLabel(run.status) : "Waiting"}</span>
                  </li>
                );
              })}
              <li className="flex justify-between gap-4">
                <span>Preview</span>
                <span>
                  {progressPage.hasPdf
                    ? "Complete"
                    : job.status === "rendering"
                      ? "Rendering…"
                      : "Waiting"}
                </span>
              </li>
            </ul>
          </div>
        )}
        {job.errorMessage && (
          <p className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            {job.errorMessage}
          </p>
        )}
      </section>

      {/*
        Preparation is not scanning, and it used to look exactly like it.

        A job is `preparing` before it has ever been reviewed — the page images
        are still being rasterised, so there is nothing to choose between yet.
        Falling through to the scan-progress grid put eight page chips on screen
        and read as "your pages went straight to the engines", which is the one
        promise this flow makes and does not break. Say what is happening and
        what comes next instead.
      */}
      {preparing ? (
        <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Getting the pages ready
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-slate-500">
            Turning {job.originalFilename} into {job.pageCount}{" "}
            {job.pageCount === 1 ? "page image" : "page images"}. You will be
            able to reorder, rotate and exclude pages before anything is sent to
            a recognition engine.
          </p>
          {/*
            The count, not just a spinner. At roughly five seconds a page a
            twenty-page source sits here for two minutes, and "it is working" and
            "it is stuck" look the same without a number that moves.
          */}
          <div className="mt-4 flex items-center gap-3">
            <div
              className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={job.pageCount || 1}
              aria-valuenow={preparedPages}
              aria-label="Pages prepared"
            >
              <div
                className="h-full rounded-full bg-blue-600 transition-[width] duration-500"
                style={{
                  width: `${Math.round((preparedPages / Math.max(job.pageCount || 1, 1)) * 100)}%`,
                }}
              />
            </div>
            <p className="text-sm tabular-nums text-slate-500" aria-live="polite">
              {preparedPages} of {job.pageCount} ready
            </p>
          </div>
          <div
            className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
            aria-hidden="true"
          >
            {Array.from({ length: Math.min(job.pageCount || 1, 8) }).map(
              (_unused, index) => (
                <div
                  key={index}
                  className={`h-40 rounded-lg ${
                    index < preparedPages
                      ? "bg-slate-200 dark:bg-slate-700"
                      : "animate-pulse bg-slate-100 dark:bg-slate-800"
                  }`}
                />
              ),
            )}
          </div>
        </section>
      ) : reviewing ? (
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
                  {pageStageLabel(job, page)}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {selected && !reviewing && (
        <section
          ref={pageSectionRef}
          className="scroll-mt-4 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                Page {selected.ordinal}
              </h2>
              <p className="text-sm text-slate-500">
                {pageStageLabel(job, selected)} · {selected.attempts} provider{" "}
                {selected.attempts === 1 ? "attempt" : "attempts"}
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
            </div>
          </div>
          {/*
            Downloads are named by engine. Unlabelled actions silently meant
            "whichever engine the plan selected", which is unguessable once two
            engines have read the same page.
          */}
          {previewEngineIds.length > 0 && (
            <div className="mt-4 space-y-2">
              {previewEngineIds.map((engineId) => {
                const run = selected.engines?.[engineId];
                return (
                  <div
                    key={`downloads-${engineId}`}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <span className="min-w-24 text-xs font-medium uppercase tracking-wide text-slate-500">
                      {engineLabel(job, engineId)}
                    </span>
                    {run?.hasMusicXml && (
                      <a
                        href={artifactUrl(
                          "musicxml",
                          selected.pageNumber,
                          engineId,
                        )}
                        download
                        className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700"
                      >
                        MusicXML
                      </a>
                    )}
                    {run?.hasPdf && (
                      <a
                        href={artifactUrl("pdf", selected.pageNumber, engineId)}
                        download
                        className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700"
                      >
                        PDF
                      </a>
                    )}
                    {run?.hasKern && (
                      <a
                        href={artifactUrl("kern", selected.pageNumber, engineId)}
                        download
                        className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700"
                      >
                        Kern
                      </a>
                    )}
                    {run?.hasMusicXml && (
                      <a
                        href={editorUrl(selected.pageNumber, engineId)}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700"
                      >
                        Open in Score Editor
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {active &&
            selected.hasMusicXml &&
            runningEngine &&
            progressPage === selected && (
              <p className="mt-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
                {effectiveLabel} MusicXML is already available.{" "}
                {engineLabel(job, runningEngine[0])} is still recognizing this
                page; comparison will appear when it finishes.
              </p>
            )}
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
          {selected.status === "succeeded" && (
            <PageComparison jobId={jobId} job={job} page={selected} />
          )}
          {/*
            One pane of the page beside another, with each side chosen by the
            reader. It used to be a fixed stack — "Scan versus HOMR" then "Scan
            versus Transcoda" — which fixed the scan on the left and made the
            one comparison it could not show the interesting one: what the two
            engines did differently.
          */}
          <div className="mt-5">
            <div className="mb-2 flex flex-wrap items-center gap-3 text-xs">
              <span className="font-medium uppercase tracking-wide text-slate-500">
                Compare
              </span>
              {(
                [
                  ["left", leftPreviewKey, setPreviewLeft],
                  ["right", rightPreviewKey, setPreviewRight],
                ] as const
              ).map(([side, value, setValue], index) => (
                <span key={side} className="flex items-center gap-2">
                  {index === 1 && <span className="text-slate-400">versus</span>}
                  <label className="sr-only" htmlFor={`preview-${side}`}>
                    {index === 0 ? "Left pane" : "Right pane"}
                  </label>
                  <select
                    id={`preview-${side}`}
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    className="rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
                  >
                    {previewChoices.map((choice) => (
                      <option key={choice.key} value={choice.key}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                </span>
              ))}
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              {[leftPreviewKey, rightPreviewKey].map((choiceKey, index) => {
                const choice =
                  previewChoices.find((entry) => entry.key === choiceKey) ||
                  previewChoices[0];
                return (
                  <div
                    key={`${choiceKey}-${index}`}
                    className="min-h-[420px] overflow-hidden rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-950"
                  >
                    {choice.kind === "scan" ? (
                      selected.hasThumbnail ? (
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
                      )
                    ) : choice.pdfUrl ? (
                      <object
                        data={choice.pdfUrl}
                        type="application/pdf"
                        className="h-[70vh] min-h-[420px] w-full"
                      >
                        <p className="p-4 text-sm">
                          PDF preview is unavailable in this browser.{" "}
                          <a className="text-blue-600 underline" href={choice.pdfUrl}>
                            Download it instead.
                          </a>
                        </p>
                      </object>
                    ) : (
                      <p className="flex min-h-[420px] items-center justify-center p-5 text-sm text-slate-500">
                        No rendered PDF is available for {choice.label} on this page.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

        </section>
      )}

      {/*
        The step between reviewing pages and having a score. Reconciling a page
        settles what *that page* says; nothing until here turns a stack of pages
        into the work, and without it the flow simply stopped after the last
        page with no indication that anything remained.
      */}
      {job.status === "succeeded" && includedPageCount > 0 && (
        <section className="rounded-xl border border-cyan-200 bg-cyan-50/40 p-5 dark:border-cyan-900 dark:bg-cyan-950/20">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            {includedPageCount === 1
              ? "Review the finished score"
              : pagesRemain
                ? "Work through the pages"
                : "Combine pages and review"}
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {decidedPages === includedPageCount
              ? `Every page is reconciled.`
              : decidedPages > 0
                ? `${decidedPages} of ${includedPageCount} pages reconciled. The rest use the ${primaryEngineName} reading.`
                : `No page has been reconciled yet, so this uses the ${primaryEngineName} reading throughout. Compare the engines on a page above to change that.`}
            {includedPageCount === 1
              ? ""
              : pagesRemain
                ? " Combining becomes available on the last page."
                : " Combining rebuilds the whole work from what you decided."}
          </p>
          {/*
            Combining is only the right next step once there are no pages left
            to review. Offering it from page one invited a reader to build the
            work out of pages they had not looked at, and gave them nothing to
            press when what they actually wanted was the next page.
          */}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {includedPageCount > 1 &&
              (pagesRemain ? (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedPage(nextIncludedPage);
                    pageSectionRef.current?.scrollIntoView?.({
                      behavior: "smooth",
                      block: "start",
                    });
                  }}
                  className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-700"
                >
                  Go to page {selectedOrdinal + 1} of {includedPageCount} →
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void runAction("reassemble", `${base}/reassemble`)}
                  disabled={Boolean(busyAction)}
                  className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-700 disabled:opacity-50"
                >
                  {busyAction === "reassemble"
                    ? "Combining…"
                    : job.hasCombinedMusicXml
                      ? "Rebuild the combined score"
                      : "Combine pages"}
                </button>
              ))}
            {(job.hasCombinedMusicXml || includedPageCount === 1) &&
              job.hasMusicXml && (
                <a
                  href={editorUrl()}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
                >
                  Open the finished score in the Score Editor
                </a>
              )}
          </div>
          {includedPageCount > 1 && !job.hasCombinedMusicXml && (
            <p className="mt-3 text-xs text-slate-500">
              {job.mergeStatus === "incompatible" || job.mergeStatus === "failed"
                ? `The pages were not combined${job.mergeReason ? `: ${job.mergeReason}` : ""}. Each page file below is complete and unaffected.`
                : "The pages have not been combined yet."}
            </p>
          )}
        </section>
      )}

      {(job.hasMusicXml || job.hasZip) && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Job downloads
          </h2>
          <div className="mt-3 flex flex-wrap gap-3">
            {/*
              Not while pages are still being recognised. The archive is built
              on demand from whatever exists, and `hasZip` turns true the moment
              the *first* page has a reading — so mid-scan this offered a
              partial archive under the words "all results". The single-page
              downloads beside it are a different claim and stay: a finished
              page's reading really is available.
            */}
            {job.hasZip && jobFinished && (
              <a
                href={artifactUrl("zip")}
                download
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
              >
                {job.status === "succeeded"
                  ? "Download all results (.zip)"
                  : "Download results so far (.zip)"}
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
            {(job.hasCombinedPdf || job.hasPdf) && (
              /*
                One route, two things: the API's `pdf` kind serves the combined
                score when there is one and the page preview otherwise. The
                button used to say "combined" for both, so a job with no
                combined score still offered one.
              */
              <a
                href={artifactUrl("pdf")}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm dark:border-slate-700"
              >
                {job.hasCombinedPdf ? "Open combined PDF" : "Open page preview PDF"}
              </a>
            )}
          </div>
          {/*
            Say what these contain. Every one is built from each page's
            *effective* MusicXML — the merged score once reconciliation
            decisions exist, the spot-reviewed reading otherwise, and the
            primary engine's raw output failing both — so "which engine?" has
            an answer, and it should not have to be inferred.
          */}
          <p className="mt-3 text-xs text-slate-600 dark:text-slate-400">
            {decidedPages > 0 ? (
              <>
                Built from your reconciled score on{" "}
                {decidedPages === 1 ? "1 page" : `${decidedPages} pages`}
                {decidedPages < includedPageCount
                  ? `, and the ${primaryEngineName} reading elsewhere.`
                  : "."}
              </>
            ) : (
              <>
                Built from the {primaryEngineName} reading. Reconcile a page
                above and these are rebuilt from what you decided.
              </>
            )}{" "}
            The archive carries both: each engine&apos;s own reading of every
            page, and the page as it now stands.
          </p>
          {job.hasCombinedMusicXml ? (
            <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              Page assembly is in beta. Measure numbering is made continuous and
              page breaks are preserved, but ties, slurs, and lyrics that cross
              a page boundary are not reconstructed. The per-page files remain
              authoritative.
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
