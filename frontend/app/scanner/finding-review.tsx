"use client";

import { useEffect, useState } from "react";

import { amendmentFor } from "./finding-amendment";
import {
  useCurrentFindingIssue,
  type FindingDisposition,
  type StandingFindingDisposition,
} from "./cross-staff-findings";
import type { ScannerCrossStaffFinding } from "./scanner-types";

/**
 * Cross-staff findings, one issue at a time.
 *
 * Replaces the list. A list of every kind with a row of controls beside each asked the
 * reviewer to hold the whole page in their head and decide in the abstract; this shows
 * the scan, the reading, and one question.
 *
 * The embed owns navigation and editing, because that is where the score is. This owns
 * the decisions, because a disposition is a scanner concept with a scanner API behind
 * it, and the embed reaches that process only through this host's proxy. The two are
 * joined by the embed telling the host which issue is on screen.
 */
const KIND_TITLES: Record<string, string> = {
  clef_profile_mismatch: "Clef differs from the expected part",
  profile_layout_deviation:
    "System has a different number of staves than expected",
  time_signature_mismatch: "Staves disagree on time signature",
  key_signature_mismatch: "Staves disagree on key signature",
  measure_count_mismatch: "Staves disagree on bar count",
  measure_duration_mismatch: "Staves disagree on bar length",
  barline_position_mismatch: "Barlines fall in different places",
  motif_articulation_mismatch: "Matching passages disagree on articulation",
  part_order_mismatch: "Parts appear in an unexpected order",
  page_staff_count_mismatch:
    "A system has a different staff count from the page",
  dangling_slur_start: "A slur opens and never closes",
  dangling_slur_stop: "A slur closes with nothing open",
};

const DISPOSITION_LABELS: Record<FindingDisposition, string> = {
  "profile-amended": "Profile widened to expect this",
  acknowledged: "Checked — reads correctly",
  "reading-flagged": "Flagged as misread",
};

/** Unknown kinds are named, never hidden: a new check must not fall silent. */
function titleFor(kind: string): string {
  return KIND_TITLES[kind] ?? kind.replace(/_/g, " ");
}

/** Sized by the embed, which reports its own height; see `ots-compare-height`. */
function useEmbedHeight(): number {
  const [height, setHeight] = useState(640);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const value = (event.data as { type?: string; height?: number } | null) || null;
      if (value?.type !== "ots-compare-height") return;
      if (typeof value.height !== "number" || !Number.isFinite(value.height)) return;
      setHeight(Math.max(480, Math.ceil(value.height)));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return height;
}

export function FindingReview({
  jobId,
  pageNumber,
  engineId,
  readingUrl,
  findings,
  dispositions,
  onDecide,
  onWithdraw,
}: {
  jobId: string;
  pageNumber: number;
  engineId: string;
  /** The reading the embed edits, proxied so the embed can reach it. */
  readingUrl: string;
  /** Held by the host only to decide whether there is anything to review at all. */
  findings: ScannerCrossStaffFinding[];
  dispositions?: StandingFindingDisposition[];
  onDecide?: (input: {
    kind: string;
    part: string | null;
    disposition: FindingDisposition;
    amendment?: { stableId: string; addClefs: string[] };
  }) => void | Promise<void>;
  onWithdraw?: (input: { kind: string; part: string | null }) => void | Promise<void>;
}) {
  const issue = useCurrentFindingIssue();
  const height = useEmbedHeight();

  if (findings.length === 0) return null;

  const base = `/api/proxy/scanner/jobs/${encodeURIComponent(jobId)}/pages/${pageNumber}`;
  const src = `/score-editor/index.html?${new URLSearchParams({
    compareLeft: readingUrl,
    // Depth matters: everything inside the regions document addresses siblings
    // relatively, including `../merged` for the save. A deeper path resolved both to
    // nonsense.
    compareRegions: `${base}/findings/regions?engine=${encodeURIComponent(engineId)}`,
    // Findings, not a comparison. The embed refuses `compareRight` in this mode: a
    // second reading would mean the caller wanted the comparison view.
    compareMode: "findings",
    leftLabel: "This reading",
  }).toString()}`;

  // The standing decision for whatever the embed is showing. Part-specific beats
  // kind-wide, matching the server.
  const standing = issue
    ? (dispositions || []).find(
        (entry) => entry.kind === issue.kind && entry.part === issue.part,
      ) ||
      (dispositions || []).find(
        (entry) => entry.kind === issue.kind && entry.part === null,
      )
    : undefined;
  const amendment = issue
    ? amendmentFor({
        kind: issue.kind,
        message: issue.message,
        ...(issue.part ? { part: issue.part } : {}),
      })
    : null;

  return (
    <section
      data-testid="finding-review"
      className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900/60"
    >
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
        Things worth a look
      </h3>
      <p className="mt-1 text-xs text-slate-500">
        Disagreements between staves, and between this score and what you said to
        expect. None of it blocks anything, and none of it has changed what was
        recognized.
      </p>

      <iframe
        data-testid="finding-review-embed"
        src={src}
        title="Review a cross-staff finding"
        className="mt-3 w-full rounded border border-slate-200 bg-white dark:border-slate-700"
        style={{ height }}
      />

      {issue && (
        <div
          data-testid="finding-review-decision"
          className="mt-3 flex flex-wrap items-center gap-2"
        >
          <span className="mr-1 text-xs text-slate-600 dark:text-slate-400">
            {titleFor(issue.kind)}
            {issue.part ? ` · ${issue.part}` : ""}
          </span>
          {standing ? (
            <>
              <span
                data-testid="finding-review-standing"
                data-disposition={standing.disposition}
                className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
              >
                {DISPOSITION_LABELS[standing.disposition]}
                {standing.part === null ? " · all parts" : ""}
              </span>
              {onWithdraw && (
                <button
                  type="button"
                  data-testid="finding-review-withdraw"
                  onClick={() =>
                    onWithdraw({ kind: issue.kind, part: standing.part })
                  }
                  className="rounded-md border border-slate-300 px-2 py-1.5 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
                >
                  Undo
                </button>
              )}
            </>
          ) : (
            onDecide && (
              <>
                {amendment && (
                  <button
                    type="button"
                    data-testid="finding-review-amend"
                    onClick={() =>
                      onDecide({
                        kind: issue.kind,
                        part: issue.part,
                        disposition: "profile-amended",
                        amendment,
                      })
                    }
                    className="rounded-md bg-cyan-600 px-2 py-1.5 text-xs font-semibold text-white hover:bg-cyan-700"
                  >
                    Expected — widen the profile
                  </button>
                )}
                <button
                  type="button"
                  data-testid="finding-review-acknowledge"
                  onClick={() =>
                    onDecide({
                      kind: issue.kind,
                      part: issue.part,
                      disposition: "acknowledged",
                    })
                  }
                  className="rounded-md border border-slate-300 px-2 py-1.5 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
                >
                  Checked — reads correctly
                </button>
                <button
                  type="button"
                  data-testid="finding-review-flag"
                  onClick={() =>
                    onDecide({
                      kind: issue.kind,
                      part: issue.part,
                      disposition: "reading-flagged",
                    })
                  }
                  className="rounded-md border border-amber-300 px-2 py-1.5 text-xs text-amber-800 hover:bg-amber-50 dark:border-amber-900 dark:text-amber-300 dark:hover:bg-amber-950/40"
                >
                  Misread — flag it
                  {issue.part ? ` (${issue.part})` : ""}
                </button>
                {/*
                  The kind-wide answer, offered only when there is a narrower one to
                  distinguish it from. With no part in play "this example" and "all of
                  them" are the same decision, and two buttons for one outcome is the
                  kind of thing the removed Dismiss/Expected pair did.
                */}
                {issue.part && issue.places > 1 && (
                  <button
                    type="button"
                    data-testid="finding-review-flag-all"
                    onClick={() =>
                      onDecide({
                        kind: issue.kind,
                        part: null,
                        disposition: "reading-flagged",
                      })
                    }
                    className="rounded-md border border-amber-300 px-2 py-1.5 text-xs text-amber-800 hover:bg-amber-50 dark:border-amber-900 dark:text-amber-300 dark:hover:bg-amber-950/40"
                  >
                    Flag all {issue.places} examples
                  </button>
                )}
              </>
            )
          )}
        </div>
      )}
    </section>
  );
}
