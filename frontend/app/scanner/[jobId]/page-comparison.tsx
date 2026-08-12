"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ScannerJob } from "../scanner-types";

type ScannerPage = ScannerJob["pages"][number];

interface ComparisonSide {
  engineId: string;
  displayName: string;
  artifactChecksumSha256: string;
  completeness?: "complete" | "possibly-incomplete" | "incomplete" | "unknown";
  unsupportedSemanticClasses: string[];
}

interface ComparisonMeasureRef {
  measureIndex: number;
  measureNumber?: string;
}

interface ComparisonWarning {
  engineId: string;
  detail: string;
}

interface ComparisonBlock {
  blockIndex: number;
  stablePartKey: string;
  baseMeasureRefs: ComparisonMeasureRef[];
  candidateMeasureRefs: ComparisonMeasureRef[];
  differenceClasses: string[];
  completenessWarnings: ComparisonWarning[];
  contentSignature: string;
}

interface ComparisonRefusal {
  detail: string;
}

interface ComparisonBlockResult {
  status: "ready" | "refused";
  block: ComparisonBlock;
  refusalReasons?: ComparisonRefusal[];
}

interface PageComparisonResult {
  statusVersion: number;
  status: "ready" | "refused";
  base: ComparisonSide;
  candidate: ComparisonSide;
  refusalReasons: ComparisonRefusal[];
  analysis?: {
    status: "succeeded" | "refused";
    blocks?: ComparisonBlock[];
  };
  geometry?: {
    status: "ready" | "refused";
    geometrySignature?: string;
    blocks: ComparisonBlockResult[];
    refusalReasons: ComparisonRefusal[];
  };
}

const DIFFERENCE_LABELS: Record<string, string> = {
  notation: "notes or rhythm",
  voice: "voices",
  staff: "staff assignment",
  attributes: "clef, key, time, or divisions",
  lyrics: "lyrics",
  dynamics: "dynamics",
  directions: "directions",
  notations: "slurs, ties, or other notation",
  "measure-added": "candidate-only measure",
  "measure-removed": "base-only measure",
};

async function responseError(
  response: Response,
  fallback: string,
): Promise<string> {
  const value = await response.json().catch(() => ({}));
  return String(value?.message || value?.error || fallback);
}

/**
 * The crop URL is bound to the job's status version and to the block content and
 * geometry signatures, so the server refuses it the moment any of them moves on.
 * A bare <img> cannot read that refusal — it would render as a broken icon — so
 * the failure is caught here and stated, like every other refusal in this view.
 */
function SourceEvidence({
  cropUrl,
  blockIndex,
  onStale,
}: {
  cropUrl: string;
  blockIndex: number;
  onStale: () => void;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [cropUrl]);

  if (failed) {
    return (
      <div
        className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
        role="alert"
      >
        <p>
          This scan crop is no longer current — the page changed after the
          comparison was loaded.
        </p>
        <button
          type="button"
          onClick={onStale}
          className="mt-2 rounded-md border border-amber-300 px-2 py-1 font-medium hover:bg-amber-100 dark:border-amber-800 dark:hover:bg-amber-900/40"
        >
          Reload the comparison
        </button>
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={cropUrl}
      alt={`Source evidence for comparison block ${blockIndex + 1}`}
      onError={() => setFailed(true)}
      className="max-h-96 w-full rounded-lg border border-slate-200 bg-white object-contain dark:border-slate-700"
    />
  );
}

function readableMeasureRange(refs: ComparisonMeasureRef[]): string {
  if (refs.length === 0) return "no corresponding measure";
  const labels = refs.map(
    (ref) => ref.measureNumber || String(ref.measureIndex + 1),
  );
  const unique = [...new Set(labels)];
  if (unique.length === 1) return `measure ${unique[0]}`;
  return `measures ${unique[0]}–${unique[unique.length - 1]}`;
}

function numericMeasureRange(
  refs: ComparisonMeasureRef[],
): { from: number; through: number } | undefined {
  if (refs.length === 0) return undefined;
  const values = refs.map((ref) =>
    /^\d+$/.test(ref.measureNumber || "")
      ? Number(ref.measureNumber)
      : Number.NaN,
  );
  if (values.some((value) => !Number.isSafeInteger(value) || value < 1))
    return undefined;
  return { from: Math.min(...values), through: Math.max(...values) };
}

function sideCaveats(side: ComparisonSide): string[] {
  const caveats: string[] = [];
  if (side.completeness && side.completeness !== "complete") {
    caveats.push(`reported output completeness as ${side.completeness}`);
  }
  if (side.unsupportedSemanticClasses.length > 0) {
    caveats.push(
      `does not recognize ${side.unsupportedSemanticClasses.join(", ")}`,
    );
  }
  return caveats;
}

function MusicXmlReading({
  artifactUrl,
  engineName,
  measureRefs,
  musicXmlCache,
}: {
  artifactUrl: string;
  engineName: string;
  measureRefs: ComparisonMeasureRef[];
  musicXmlCache: Map<string, string>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const range = useMemo(() => numericMeasureRange(measureRefs), [measureRefs]);

  useEffect(() => {
    if (measureRefs.length === 0) return;
    const container = containerRef.current;
    if (!container) return;
    const controller = new AbortController();
    let cancelled = false;
    setState("loading");
    setMessage("");

    const loadMusicXml = async () => {
      const cached = musicXmlCache.get(artifactUrl);
      if (cached !== undefined) return cached;
      const response = await fetch(artifactUrl, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          await responseError(response, `Unable to load ${engineName}`),
        );
      }
      const musicXml = await response.text();
      musicXmlCache.set(artifactUrl, musicXml);
      return musicXml;
    };

    void Promise.all([import("opensheetmusicdisplay"), loadMusicXml()])
      .then(async ([{ OpenSheetMusicDisplay }, musicXml]) => {
        if (cancelled) return;
        const options: Record<string, unknown> = {
          backend: "svg",
          autoResize: true,
          drawTitle: false,
          pageFormat: "Endless",
        };
        if (range) {
          options.drawFromMeasureNumber = range.from;
          options.drawUpToMeasureNumber = range.through;
        }
        const osmd = new OpenSheetMusicDisplay(container, options);
        await osmd.load(musicXml);
        osmd.Zoom = 0.8;
        await osmd.render();
        if (!cancelled) setState("ready");
      })
      .catch((cause) => {
        if (cancelled || controller.signal.aborted) return;
        setState("error");
        setMessage(cause instanceof Error ? cause.message : String(cause));
      });

    return () => {
      cancelled = true;
      controller.abort();
      container.innerHTML = "";
    };
  }, [artifactUrl, engineName, measureRefs, musicXmlCache, range]);

  if (measureRefs.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-slate-300 p-5 text-sm text-slate-500 dark:border-slate-700">
        This engine has no corresponding measure in this block.
      </p>
    );
  }

  return (
    <div>
      {!range && (
        <p className="mb-2 text-xs text-amber-700 dark:text-amber-300">
          These measure labels are not a simple numeric range, so the full-page
          reading is shown.
        </p>
      )}
      {state === "loading" && (
        <p className="mb-2 text-xs text-slate-500" aria-live="polite">
          Loading {engineName} reading…
        </p>
      )}
      {state === "error" && (
        <p className="mb-2 text-xs text-red-700 dark:text-red-300" role="alert">
          {message}
        </p>
      )}
      <div
        ref={containerRef}
        className="max-h-[28rem] overflow-auto rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700"
        style={{ minHeight: 140 }}
      />
    </div>
  );
}

export default function PageComparison({
  jobId,
  job,
  page,
}: {
  jobId: string;
  job: ScannerJob;
  page: ScannerPage;
}) {
  const eligibleEngineIds = useMemo(
    () =>
      (job.enginePlan?.engineIds || Object.keys(page.engines || {})).filter(
        (engineId) => {
          const run = page.engines?.[engineId];
          return run?.status === "succeeded" && run.hasMusicXml;
        },
      ),
    [job.enginePlan?.engineIds, page.engines],
  );
  const defaultBase = eligibleEngineIds.includes(
    job.enginePlan?.primaryEngineId || "",
  )
    ? String(job.enginePlan?.primaryEngineId)
    : eligibleEngineIds[0] || "";
  const defaultCandidate =
    eligibleEngineIds.find((engineId) => engineId !== defaultBase) || "";
  const [open, setOpen] = useState(false);
  const [baseEngine, setBaseEngine] = useState(defaultBase);
  const [candidateEngine, setCandidateEngine] = useState(defaultCandidate);
  const [comparison, setComparison] = useState<PageComparisonResult | null>(
    null,
  );
  const [selectedBlockIndex, setSelectedBlockIndex] = useState<number | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const musicXmlCache = useRef(new Map<string, string>());
  const base = `/api/proxy/scanner/jobs/${encodeURIComponent(jobId)}`;

  useEffect(() => {
    setOpen(false);
    setBaseEngine(defaultBase);
    setCandidateEngine(defaultCandidate);
    setComparison(null);
    setSelectedBlockIndex(null);
    setError(null);
    musicXmlCache.current.clear();
  }, [defaultBase, defaultCandidate, page.pageNumber]);

  useEffect(() => {
    if (
      !open ||
      !baseEngine ||
      !candidateEngine ||
      baseEngine === candidateEngine
    )
      return;
    const controller = new AbortController();
    const params = new URLSearchParams({
      baseEngine,
      candidateEngine,
    });
    setLoading(true);
    setError(null);
    setComparison(null);
    setSelectedBlockIndex(null);
    musicXmlCache.current.clear();
    fetch(`${base}/pages/${page.pageNumber}/comparison?${params.toString()}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(
            await responseError(response, "Unable to compare these readings"),
          );
        }
        return (await response.json()) as PageComparisonResult;
      })
      .then((result) => {
        setComparison(result);
        const firstReady = result.geometry?.blocks.find(
          (entry) => entry.status === "ready",
        );
        setSelectedBlockIndex(firstReady?.block.blockIndex ?? null);
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [base, baseEngine, candidateEngine, open, page.pageNumber, reloadToken]);

  if (eligibleEngineIds.length < 2) return null;

  const engineName = (engineId: string) =>
    job.enginePlan?.capabilitySnapshots[engineId]?.displayName || engineId;
  const readyBlocks =
    comparison?.geometry?.blocks.filter(
      (entry): entry is ComparisonBlockResult & { status: "ready" } =>
        entry.status === "ready",
    ) || [];
  const selectedBlock = readyBlocks.find(
    (entry) => entry.block.blockIndex === selectedBlockIndex,
  )?.block;
  // The whole-page view needs no crops, so it survives a geometry refusal.
  // Prefer the structural analysis and fall back to whatever the geometry join
  // carried through.
  const allBlocks =
    comparison?.analysis?.blocks ||
    comparison?.geometry?.blocks.map((entry) => entry.block) ||
    [];
  /**
   * The whole page goes to the score editor's compare mode — the same embed
   * change review uses. Measure highlighting there comes from MuseScore's own
   * layout (`measurePositions()` plus the engine's staff bands), which is the
   * one source of that geometry in the product; rendering the page a second way
   * here would put the scanner's compare in a different engine from every other
   * comparator, with different line breaks for the same score.
   */
  const geometrySignature = comparison?.geometry?.geometrySignature;

  const readingUrl = (side: ComparisonSide) =>
    `${base}/pages/${page.pageNumber}/comparison/readings/${encodeURIComponent(side.engineId)}?${new URLSearchParams(
      {
        statusVersion: String(comparison?.statusVersion || ""),
        artifactChecksumSha256: side.artifactChecksumSha256,
      },
    ).toString()}`;

  const embeddedCompareUrl = comparison
    ? `/score-editor/index.html?${new URLSearchParams({
        compareLeft: readingUrl(comparison.base),
        compareRight: readingUrl(comparison.candidate),
        leftLabel: comparison.base.displayName,
        rightLabel: comparison.candidate.displayName,
        // Hand the editor the differences we already computed. Its own measure
        // signature cannot separate these two documents — it does not normalise
        // <duration> against <divisions> — so it marks every measure of an
        // agreeing page as changed.
        compareRegions: `${base}/pages/${page.pageNumber}/comparison/regions?${new URLSearchParams(
          {
            baseEngine: comparison.base.engineId,
            candidateEngine: comparison.candidate.engineId,
          },
        ).toString()}`,
      }).toString()}`
    : undefined;

  const cropUrl =
    comparison && selectedBlock && geometrySignature
      ? `${base}/pages/${page.pageNumber}/comparison/blocks/${selectedBlock.blockIndex}/crop?${new URLSearchParams(
          {
            baseEngine: comparison.base.engineId,
            candidateEngine: comparison.candidate.engineId,
            statusVersion: String(comparison.statusVersion),
            contentSignature: selectedBlock.contentSignature,
            geometrySignature,
          },
        ).toString()}`
      : undefined;

  return (
    <section className="mt-4 rounded-xl border border-cyan-200 bg-cyan-50/40 p-4 dark:border-cyan-900 dark:bg-cyan-950/20">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Compare recognition engines
          </h3>
          <p className="mt-1 max-w-3xl text-xs text-slate-600 dark:text-slate-400">
            Read-only: inspect where two engine readings differ against the
            retained scan. No reconciliation choices are saved yet.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="rounded-lg border border-cyan-300 bg-white px-3 py-2 text-sm text-cyan-800 hover:bg-cyan-50 dark:border-cyan-800 dark:bg-slate-900 dark:text-cyan-200"
          aria-expanded={open}
        >
          {open ? "Close comparison" : "Compare engine readings"}
        </button>
      </div>

      {open && (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-slate-700 dark:text-slate-300">
              Base reading
              <select
                aria-label="Base reading"
                value={baseEngine}
                onChange={(event) => setBaseEngine(event.target.value)}
                className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
              >
                {eligibleEngineIds.map((engineId) => (
                  <option
                    key={engineId}
                    value={engineId}
                    disabled={engineId === candidateEngine}
                  >
                    {engineName(engineId)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-slate-700 dark:text-slate-300">
              Candidate reading
              <select
                aria-label="Candidate reading"
                value={candidateEngine}
                onChange={(event) => setCandidateEngine(event.target.value)}
                className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
              >
                {eligibleEngineIds.map((engineId) => (
                  <option
                    key={engineId}
                    value={engineId}
                    disabled={engineId === baseEngine}
                  >
                    {engineName(engineId)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {comparison &&
            [comparison.base, comparison.candidate].some(
              (side) => sideCaveats(side).length > 0,
            ) && (
              <ul className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                {[comparison.base, comparison.candidate].flatMap((side) =>
                  sideCaveats(side).map((caveat) => (
                    <li key={`${side.engineId}-${caveat}`}>
                      {side.displayName} {caveat}.
                    </li>
                  )),
                )}
              </ul>
            )}

          {loading && (
            <p className="text-sm text-slate-500" aria-live="polite">
              Comparing engine readings…
            </p>
          )}
          {error && (
            <p
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
              role="alert"
            >
              {error}
            </p>
          )}
          {comparison?.status === "refused" && readyBlocks.length === 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <p className="font-medium">
                These readings cannot be compared safely.
              </p>
              <ul className="mt-1 list-disc pl-5">
                {comparison.refusalReasons.map((reason, index) => (
                  <li key={`${reason.detail}-${index}`}>{reason.detail}</li>
                ))}
              </ul>
            </div>
          )}
          {comparison?.status === "ready" &&
            comparison.geometry?.status === "refused" &&
            readyBlocks.length === 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                <p className="font-medium">
                  The differences have no verified image evidence.
                </p>
                <p className="mt-1">
                  The detail view is withheld rather than pairing a reading with
                  an uncertain part of the scan.
                </p>
                <ul className="mt-1 list-disc pl-5">
                  {comparison.geometry.refusalReasons.map((reason, index) => (
                    <li key={`${reason.detail}-${index}`}>{reason.detail}</li>
                  ))}
                </ul>
              </div>
            )}
          {comparison &&
            comparison.geometry &&
            readyBlocks.length > 0 &&
            comparison.geometry.refusalReasons.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                <p className="font-medium">
                  Some differences have no verified image evidence.
                </p>
                <p className="mt-1">
                  Showing {readyBlocks.length} of {comparison.geometry.blocks.length}{" "}
                  differing blocks whose locations can be proven. The remaining
                  blocks are withheld.
                </p>
              </div>
            )}
          {comparison &&
            (comparison.geometry?.status === "ready" || readyBlocks.length > 0) && (
              <>
                {readyBlocks.length === 0 ? (
                  <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
                    The semantic measure comparison found no differences on this
                    page.
                  </p>
                ) : (
                  <div className="grid gap-4 xl:grid-cols-[18rem_minmax(0,1fr)]">
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                        {readyBlocks.length} differing{" "}
                        {readyBlocks.length === 1 ? "block" : "blocks"}
                      </p>
                      <ol className="mt-2 max-h-[34rem] space-y-2 overflow-auto pr-1">
                        {readyBlocks.map(({ block }, index) => (
                          <li key={block.contentSignature}>
                            <button
                              type="button"
                              aria-pressed={
                                selectedBlockIndex === block.blockIndex
                              }
                              onClick={() =>
                                setSelectedBlockIndex(block.blockIndex)
                              }
                              className={`w-full rounded-lg border px-3 py-2 text-left text-xs ${
                                selectedBlockIndex === block.blockIndex
                                  ? "border-cyan-500 bg-white ring-2 ring-cyan-200 dark:bg-slate-900 dark:ring-cyan-900"
                                  : "border-slate-200 bg-white/70 hover:border-cyan-300 dark:border-slate-800 dark:bg-slate-900/70"
                              }`}
                            >
                              <span className="font-semibold">
                                Difference {index + 1}
                              </span>
                              <span className="mt-1 block text-slate-600 dark:text-slate-400">
                                {comparison.base.displayName}:{" "}
                                {readableMeasureRange(block.baseMeasureRefs)}
                              </span>
                              <span className="block text-slate-600 dark:text-slate-400">
                                {comparison.candidate.displayName}:{" "}
                                {readableMeasureRange(
                                  block.candidateMeasureRefs,
                                )}
                              </span>
                              <span className="mt-1 block text-slate-500">
                                {block.differenceClasses
                                  .map(
                                    (difference) =>
                                      DIFFERENCE_LABELS[difference] ||
                                      difference,
                                  )
                                  .join(", ")}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ol>
                    </div>

                    {selectedBlock && cropUrl && (
                      <div className="space-y-4">
                        <div>
                          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                            Source evidence
                          </p>
                          <SourceEvidence
                            cropUrl={cropUrl}
                            blockIndex={selectedBlock.blockIndex}
                            onStale={() => setReloadToken((token) => token + 1)}
                          />
                        </div>

                        {selectedBlock.completenessWarnings.length > 0 && (
                          <ul className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                            {selectedBlock.completenessWarnings.map(
                              (warning, index) => (
                                <li
                                  key={`${warning.engineId}-${warning.detail}-${index}`}
                                >
                                  {engineName(warning.engineId)}:{" "}
                                  {warning.detail}
                                </li>
                              ),
                            )}
                          </ul>
                        )}

                        {/*
                          Side by side, so neither reading pushes the other
                          below the fold and the two can be read against each
                          other. Each pane loads and fails independently.
                        */}
                        <div className="grid gap-4 lg:grid-cols-2">
                          {[comparison.base, comparison.candidate].map(
                            (side, index) => {
                              const refs =
                                index === 0
                                  ? selectedBlock.baseMeasureRefs
                                  : selectedBlock.candidateMeasureRefs;
                              return (
                                <div key={side.engineId} className="min-w-0">
                                  <h4 className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                                    {side.displayName} reading —{" "}
                                    {readableMeasureRange(refs)}
                                  </h4>
                                  <MusicXmlReading
                                    artifactUrl={readingUrl(side)}
                                    engineName={side.displayName}
                                    measureRefs={refs}
                                    musicXmlCache={musicXmlCache.current}
                                  />
                                </div>
                              );
                            },
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

          {/*
            The whole page, below the block work, in the score editor's compare
            mode — the same embed change review uses. It needs no crops, so it
            still renders when geometry refuses and the block evidence is
            withheld.
          */}
          {comparison && embeddedCompareUrl && allBlocks.length > 0 && (
            <div className="border-t border-slate-200 pt-5 dark:border-slate-800">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Whole-page diff review
                </h4>
                <p className="text-xs text-slate-500">
                  {comparison.base.displayName} versus{" "}
                  {comparison.candidate.displayName}, bar by bar
                </p>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                The editor aligns and highlights the whole page itself. Its
                highlighting is the editor&apos;s own comparison, not the{" "}
                {allBlocks.length} semantic{" "}
                {allBlocks.length === 1 ? "block" : "blocks"} listed above, so
                the two can disagree.
              </p>
              {/*
                Two whole scores side by side need far more width than the
                page's centered column allows, so the frame is pulled out of it
                and centered on the viewport instead. It takes the full width
                deliberately — measured on a 2560px display, an earlier 120rem
                cap left 320px of dead margin on each side. The 2rem it gives
                back stops a vertical scrollbar pushing a horizontal one onto
                the page.
              */}
              <div className="relative left-1/2 mt-3 w-[calc(100vw-2rem)] -translate-x-1/2 bg-slate-100 p-3 dark:bg-slate-950/60">
                <iframe
                  key={embeddedCompareUrl}
                  src={embeddedCompareUrl}
                  title={`Whole-page comparison of ${comparison.base.displayName} and ${comparison.candidate.displayName}`}
                  className="h-[min(85vh,60rem)] min-h-[38rem] w-full rounded-lg border border-slate-200 bg-white dark:border-slate-800"
                />
                <a
                  href={embeddedCompareUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block text-xs text-cyan-700 hover:underline dark:text-cyan-300"
                >
                  Open the comparison in its own tab ↗
                </a>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
