"use client";

import Link from "next/link";
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
  layoutReconciliation?: { engineId: string; note: string };
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
/** Breathing room kept between a full-width row and the window edge. */
const FULL_BLEED_GUTTER = 16;

/**
 * A row that spans the window, wherever it happens to sit in the page.
 *
 * The usual CSS trick — `left: 50%` with `translateX(-50%)` and a `100vw`
 * width — quietly assumes the element's containing block is centred in the
 * window. This one was not: it sat in the right-hand cell of an
 * `18rem minmax(0,1fr)` grid, whose centre is 152px right of the window's, so
 * the editor started 168px in and ran 136px off the right-hand side, taking
 * the whole page's horizontal scrollbar with it.
 *
 * So it measures instead of assuming. The parent's own left edge is what says
 * how far back to pull, and `documentElement.clientWidth` is the width that is
 * actually available — unlike `100vw`, it excludes the scrollbar rather than
 * needing a guess subtracted from it. Nothing here depends on an ancestor
 * being where it was when this was written.
 */
/**
 * The height the embedded editor asked for, or null until it says.
 *
 * The rows view does not scroll itself, so the frame has to be as tall as its
 * content — otherwise a reader gets two scrollbars and the shorter of two
 * viewports. A minimum keeps the frame from collapsing while the readings load,
 * and a maximum is deliberately absent: the page's own scrollbar is the point.
 */
function useEmbeddedCompareHeight(): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Same-origin only: the embed is served from this site, and a height from
      // anywhere else is not this editor talking.
      if (event.origin !== window.location.origin) return;
      const value = (event.data as { type?: string; height?: number } | null) || null;
      if (value?.type !== 'ots-compare-height') return;
      if (typeof value.height !== 'number' || !Number.isFinite(value.height)) return;
      setHeight(Math.max(480, Math.ceil(value.height)));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  return height;
}

function FullBleed({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [bleed, setBleed] = useState<{ marginLeft: number; width: number } | null>(
    null,
  );

  useEffect(() => {
    const node = ref.current;
    const parent = node?.parentElement;
    if (!node || !parent) return;
    const measure = () => {
      // The parent's position, not this element's: a negative margin here moves
      // this box and not its parent, so the parent stays a stable reference.
      const left = parent.getBoundingClientRect().left;
      const available = document.documentElement.clientWidth;
      setBleed({
        marginLeft: FULL_BLEED_GUTTER - left,
        width: Math.max(0, available - FULL_BLEED_GUTTER * 2),
      });
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(parent);
    observer?.observe(document.documentElement);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  return (
    <div
      ref={ref}
      className={className}
      // Until it has been measured it is an ordinary block, which is the right
      // thing to be wrong about: too narrow never breaks the page's layout.
      style={bleed ? { marginLeft: bleed.marginLeft, width: bleed.width } : undefined}
    >
      {children}
    </div>
  );
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

export default function PageComparison({
  jobId,
  job,
  page,
  open = false,
}: {
  jobId: string;
  job: ScannerJob;
  page: ScannerPage;
  /** True on the comparison's own page, where there is nothing to expand. */
  open?: boolean;
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
  const embeddedHeight = useEmbeddedCompareHeight();
  const base = `/api/proxy/scanner/jobs/${encodeURIComponent(jobId)}`;

  useEffect(() => {
    setBaseEngine(defaultBase);
    setCandidateEngine(defaultCandidate);
    setComparison(null);
    setSelectedBlockIndex(null);
    setError(null);
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
  // Two different failures used to read the same. "Cannot be compared safely"
  // is true only when the readings could not be lined up at all; once the
  // analysis has succeeded they *were* compared, and what is missing is the
  // scan evidence for where the differences are — a different problem with a
  // different answer, and one this page hid behind the wrong sentence.
  const readingsAligned =
    comparison?.status === "ready" || comparison?.analysis?.status === "succeeded";
  const readyBlocks =
    comparison?.geometry?.blocks.filter(
      (entry): entry is ComparisonBlockResult & { status: "ready" } =>
        entry.status === "ready",
    ) || [];
  /*
    Opens on the first difference that has a place on the scan.

    It used to be chosen by clicking the list beside the editor, and when that
    list was folded into the editor nothing chose it any more — so the editor
    opened on every system of the page at once, which is a page-long document
    to scroll through to reach the one thing the reader came for. The editor's
    own arrows move from here.
  */
  const selectedBlock =
    (selectedBlockIndex === null
      ? readyBlocks[0]
      : readyBlocks.find((entry) => entry.block.blockIndex === selectedBlockIndex)
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

  // `baseEngine` is not redundant with the pair in the path: a reading whose
  // parts were folded onto the other reading's staves has to be served folded,
  // or this pane would number its bars differently from the blocks drawn on it.
  const readingUrl = (side: ComparisonSide) =>
    `${base}/pages/${page.pageNumber}/comparison/readings/${encodeURIComponent(side.engineId)}?${new URLSearchParams(
      {
        statusVersion: String(comparison?.statusVersion || ""),
        artifactChecksumSha256: side.artifactChecksumSha256,
        baseEngine: comparison?.base.engineId || "",
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
        // One row per system of the scan, each engine's reading beneath it.
        compareMode: "rows",
        // Only the lines this difference falls on. The gutter is the index, so
        // the rows do not have to be one too — and a reviewer who clicked a
        // difference is not asking about the agreeing lines below it.
        ...(selectedBlock === undefined
          ? {}
          : { compareBlock: String(selectedBlock.blockIndex) }),
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
      {/*
        The card is a doorway when it is not the page.

        Comparing wants the whole window — three scores stacked over a scan —
        and expanding it inside a card left it competing with the page's own
        downloads and previews for the width, below a fold that grew as the
        readings loaded. A page of its own also gives it a URL, so a reviewer
        can come back to a difference, or send it to someone.
      */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Compare recognition engines
          </h3>
          <p className="mt-1 max-w-3xl text-xs text-slate-600 dark:text-slate-400">
            Inspect where two engine readings differ against the retained scan,
            and reconcile them into one score.
          </p>
        </div>
        {!open && (
          <Link
            href={`/scanner/${encodeURIComponent(jobId)}/pages/${page.pageNumber}/compare`}
            className="rounded-lg border border-cyan-300 bg-white px-3 py-2 text-sm text-cyan-800 hover:bg-cyan-50 dark:border-cyan-800 dark:bg-slate-900 dark:text-cyan-200"
          >
            Compare engine readings →
          </Link>
        )}
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
          {comparison?.layoutReconciliation && (
            // The candidate pane is then not literally the file the engine
            // produced, and a reviewer comparing it against the download would
            // otherwise be left to work that out for themselves.
            <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
              <span className="font-medium">
                {engineName(comparison.layoutReconciliation.engineId)} was regrouped
                to line up.
              </span>{" "}
              {comparison.layoutReconciliation.note}
            </p>
          )}
          {comparison?.status === "refused" &&
            readyBlocks.length === 0 &&
            !readingsAligned && (
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
          {comparison &&
            readingsAligned &&
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
                  {(comparison.geometry.refusalReasons.length > 0
                    ? comparison.geometry.refusalReasons
                    : comparison.refusalReasons
                  ).map((reason, index) => (
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
                ) : null}

                {/*
                  The list of differences and the cropped scrap of scan beside
                  it are gone. They were a third and fourth place to look at one
                  difference — and the crop was the same system the merge editor
                  already draws, cut out and shown again, smaller. The editor
                  names the difference, boxes it on the scan it came from, and
                  moves to the next one; there is nothing left for a card
                  outside it to add.
                */}
                {/*
                  The merge editor for the selected difference, and only for it.
                  It sat below as a separate whole-page card, which put the
                  evidence for a difference and the place you act on it in two
                  different parts of the page, with every agreeing line between.

                  It is a sibling of the block grid rather than a cell in it.
                  Three scores stacked need the full width — measured on a
                  2560px display, an earlier 120rem cap left 320px of dead
                  margin either side — and a full-width box inside the grid's
                  right-hand column would lie across the difference list.
                */}
                {selectedBlock && embeddedCompareUrl && (
                  <FullBleed className="mt-4 bg-slate-100 p-3 dark:bg-slate-950/60">
                    <iframe
                      key={embeddedCompareUrl}
                      src={embeddedCompareUrl}
                      title={`Reconciling difference ${selectedBlock.blockIndex + 1} of page ${page.pageNumber}`}
                      style={embeddedHeight ? { height: embeddedHeight } : undefined}
                      className="block min-h-[30rem] w-full rounded-lg border border-slate-200 bg-white dark:border-slate-800"
                    />
                  </FullBleed>
                )}
              </>
            )}


          {/*
            Nothing could be placed on the scan, so there is no difference to
            click — but the scan's systems are known regardless, and withholding
            the merge editor here would leave the reviewer with no way to see
            the page at all. Decisions stay impossible: their signatures are
            withheld for exactly these blocks (§7).
          */}
          {comparison &&
            embeddedCompareUrl &&
            allBlocks.length > 0 &&
            readyBlocks.length === 0 && (
              <div className="border-t border-slate-200 pt-5 dark:border-slate-800">
                <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Review the page
                </h4>
                <p className="mt-1 text-xs text-slate-500">
                  None of the {allBlocks.length}{" "}
                  {allBlocks.length === 1 ? "difference" : "differences"} could
                  be located on the scan, so none can be decided. The readings
                  are still shown line by line.
                </p>
                <FullBleed className="mt-3 bg-slate-100 p-3 dark:bg-slate-950/60">
                  <iframe
                    key={embeddedCompareUrl}
                    src={embeddedCompareUrl}
                    title={`Reviewing page ${page.pageNumber}`}
                    style={embeddedHeight ? { height: embeddedHeight } : undefined}
                    className="block min-h-[30rem] w-full rounded-lg border border-slate-200 bg-white dark:border-slate-800"
                  />
                </FullBleed>
              </div>
            )}
        </div>
      )}
    </section>
  );
}
