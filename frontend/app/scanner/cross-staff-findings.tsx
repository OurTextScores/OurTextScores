"use client";

import { useEffect, useState } from "react";

import { amendmentFor } from "./finding-amendment";
import type { ScannerCrossStaffFinding } from "./scanner-types";

export type FindingDisposition =
  | "profile-amended"
  | "acknowledged"
  | "reading-flagged";

export interface StandingFindingDisposition {
  kind: string;
  part: string | null;
  disposition: FindingDisposition;
}

/**
 * What a standing decision means to a reader.
 *
 * `reading-flagged` is absent from the suppressing set on purpose: a flagged finding is
 * an unresolved problem, and hiding it because someone noticed it would lose the only
 * record that anything is wrong.
 */
const DISPOSITION_LABELS: Record<FindingDisposition, string> = {
  "profile-amended": "Profile widened to expect this",
  acknowledged: "Checked — reads correctly",
  "reading-flagged": "Flagged as misread",
};

const SUPPRESSING: FindingDisposition[] = ["profile-amended", "acknowledged"];

/**
 * The standing decision covering a finding.
 *
 * Part-specific beats kind-wide, matching the server: the narrower statement is the more
 * considered one, and is the one a reviewer would be surprised to lose. A finding with no
 * part can only be matched kind-wide, never by some other part's decision.
 */
function dispositionFor(
  finding: ScannerCrossStaffFinding,
  dispositions: StandingFindingDisposition[],
): StandingFindingDisposition | undefined {
  const forKind = (dispositions || []).filter((entry) => entry.kind === finding.kind);
  if (finding.part) {
    const specific = forKind.find((entry) => entry.part === finding.part);
    if (specific) return specific;
  }
  return forKind.find((entry) => entry.part === null);
}

/** One engine's findings, kept engine-scoped because a crop needs both the engine and
 *  the finding's index within *that* engine's list to address it. */
export interface CrossStaffFindingSource {
  engineId: string;
  findings: ScannerCrossStaffFinding[];
}

interface LocatedFinding {
  finding: ScannerCrossStaffFinding;
  engineId: string;
  index: number;
}

/**
 * Cross-staff disagreements, shown to a reader before they compare the engines.
 *
 * Read-only, deliberately. There were Dismiss and "Expected" buttons here, and both
 * ran the same code: hide the row, remember it in this browser's localStorage. The
 * differentiated label implied the system had recorded *which* judgement was made and
 * would act on it - amend the profile, route the other kind to review - and none of
 * that existed. A control that claims a consequence it does not have is worse than no
 * control, so until the decisions are recorded somewhere a second reader can see, this
 * states the evidence and asks for nothing.
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

/** Unknown kinds are named, never hidden: a new check must not fall silent. */
function titleFor(kind: string): string {
  return KIND_TITLES[kind] ?? kind.replace(/_/g, " ");
}

/**
 * A finding with no system is about the page, not a place on it.
 *
 * `page_staff_count_mismatch` and `part_order_mismatch` are raised with staff positions
 * and no system at all. Offering "show me" for those would promise a crop the server
 * will refuse, so the control is simply absent rather than present and broken.
 */
function isLocatable(finding: ScannerCrossStaffFinding): boolean {
  return Number.isInteger(finding.system);
}

/**
 * The strip of page this finding is talking about, fetched only when asked for.
 *
 * Not eagerly: a page can carry seventeen findings, and rendering seventeen crops to
 * answer a question nobody asked costs seventeen server-side image extractions.
 */
function FindingCrop({
  jobId,
  pageNumber,
  statusVersion,
  located,
}: {
  jobId: string;
  pageNumber: number;
  statusVersion: number;
  located: LocatedFinding;
}) {
  const [shown, setShown] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!shown) {
    return (
      <button
        type="button"
        data-testid="cross-staff-finding-show"
        onClick={() => setShown(true)}
        className="mt-1 text-xs font-medium text-sky-700 underline underline-offset-2 hover:text-sky-900 dark:text-sky-400 dark:hover:text-sky-300"
      >
        Show me
      </button>
    );
  }

  const src = `/api/proxy/scanner/jobs/${jobId}/pages/${pageNumber}/engines/${located.engineId}/findings/${located.index}/crop?${new URLSearchParams(
    { statusVersion: String(statusVersion) },
  ).toString()}`;

  return (
    <div className="mt-2">
      {failed ? (
        // The server refuses a crop it cannot place rather than guessing, so this is a
        // real answer: we do not know where this is. Saying so beats an empty frame.
        <p
          data-testid="cross-staff-finding-crop-unavailable"
          className="text-xs text-slate-500"
        >
          This one could not be located on the page.
        </p>
      ) : (
        <div className="w-fit overflow-hidden rounded border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            data-testid="cross-staff-finding-crop"
            alt={`The passage on page ${pageNumber} that this concerns`}
            className="block max-h-64 w-auto max-w-full"
            onError={() => setFailed(true)}
          />
        </div>
      )}
      <button
        type="button"
        onClick={() => setShown(false)}
        className="mt-1 text-xs text-slate-500 underline underline-offset-2 hover:text-slate-700 dark:hover:text-slate-300"
      >
        Hide
      </button>
    </div>
  );
}

/**
 * The issue the embed is currently showing.
 *
 * The embed navigates; the host decides. Keeping the controls here rather than inside
 * the editor is deliberate -- a disposition is a scanner concept with a scanner API
 * behind it, and the embed reaches that process only through this host's proxy. The
 * price is that the host must be told what is on screen, or its controls would answer a
 * different question from the one being shown.
 */
export interface CurrentIssue {
  kind: string;
  part: string | null;
  /** The first finding's own words; the profile amendment is derived from it. */
  message: string;
  index: number;
  total: number;
  places: number;
}

export function useCurrentFindingIssue(): CurrentIssue | null {
  const [issue, setIssue] = useState<CurrentIssue | null>(null);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Same-origin only: the embed is served from this site, and an issue from anywhere
      // else is not this editor talking.
      if (event.origin !== window.location.origin) return;
      const value = (event.data as (CurrentIssue & { type?: string }) | null) || null;
      if (value?.type !== "ots-finding-issue") return;
      if (typeof value.kind !== "string" || !value.kind) return;
      setIssue({
        kind: value.kind,
        part: typeof value.part === "string" ? value.part : null,
        message: typeof value.message === "string" ? value.message : "",
        index: Number(value.index) || 0,
        total: Number(value.total) || 0,
        places: Number(value.places) || 0,
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return issue;
}

export function CrossStaffFindings({
  sources,
  jobId,
  pageNumber,
  statusVersion,
  editorUrlFor,
  dispositions,
  onDecide,
  onWithdraw,
}: {
  sources: CrossStaffFindingSource[];
  jobId?: string;
  pageNumber?: number;
  statusVersion?: number;
  /**
   * Opens the editor to answer this finding, carrying its identity so the save is
   * attributed to the finding rather than to a disagreement between engines.
   */
  editorUrlFor?: (
    engineId: string,
    finding: { kind: string; part?: string },
  ) => string;
  /** Standing decisions, from the server so every reviewer sees the same ones. */
  dispositions?: StandingFindingDisposition[];
  /**
   * Record a decision. Only offered once it has somewhere to go: a control claiming a
   * consequence it does not have is worse than no control, which is why the original
   * Dismiss and Expected buttons were removed rather than relabelled.
   */
  onDecide?: (input: {
    kind: string;
    part: string | null;
    disposition: FindingDisposition;
    amendment?: { stableId: string; addClefs: string[] };
  }) => void | Promise<void>;
  onWithdraw?: (input: { kind: string; part: string | null }) => void | Promise<void>;
}) {
  // Flattened for display but each entry keeps its engine and its index within that
  // engine's list, because that pair is the crop's address.
  const located: LocatedFinding[] = (sources || []).flatMap((source) =>
    (source.findings || []).map((finding, index) => ({
      finding,
      engineId: source.engineId,
      index,
    })),
  );
  if (located.length === 0) return null;
  const canLocate =
    jobId !== undefined && pageNumber !== undefined && statusVersion !== undefined;

  // Grouped by kind so eleven repetitions of one disagreement read as one thing with a
  // count, rather than eleven rows that bury everything else.
  const byKind = new Map<string, LocatedFinding[]>();
  for (const entry of located) {
    byKind.set(entry.finding.kind, [
      ...(byKind.get(entry.finding.kind) ?? []),
      entry,
    ]);
  }

  // Answered groups are folded away, never deleted. The findings are exactly as the
  // engine reported them; this is a view over them, and it stays reversible.
  const isSuppressed = (group: LocatedFinding[]) => {
    const standing = dispositionFor(group[0].finding, dispositions || []);
    return standing ? SUPPRESSING.includes(standing.disposition) : false;
  };
  const groups = [...byKind.entries()];
  const openGroups = groups.filter(([, group]) => !isSuppressed(group));
  const suppressedGroups = groups.filter(([, group]) => isSuppressed(group));

  return (
    <section
      data-testid="cross-staff-findings"
      className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900/60"
    >
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
        Things worth a look
      </h3>
      <p className="mt-1 text-xs text-slate-500">
        Disagreements between staves, and between this score and what you said
        to expect. Evidence for reading the comparison below — none of it blocks
        anything, and none of it has changed what was recognized.
      </p>
      <ul className="mt-3 space-y-2">
        {[...openGroups, ...suppressedGroups].map(([kind, group]) => (
          <li
            key={kind}
            data-testid="cross-staff-finding"
            data-kind={kind}
            data-count={group.length}
            className="rounded border border-slate-200 bg-white p-3 text-xs dark:border-slate-700 dark:bg-slate-900"
          >
            <div className="font-medium text-slate-900 dark:text-slate-100">
              {titleFor(kind)}
              {group.length > 1 ? ` · ${group.length} places` : ""}
            </div>
            {(() => {
              const first = group[0].finding;
              const standing = dispositionFor(first, dispositions || []);
              if (!standing) return null;
              return (
                <p
                  data-testid="cross-staff-finding-disposition"
                  data-disposition={standing.disposition}
                  className="mt-1 text-xs text-slate-500"
                >
                  {DISPOSITION_LABELS[standing.disposition]}
                  {standing.part === null ? " (all parts)" : ""}
                  {onWithdraw && (
                    <button
                      type="button"
                      data-testid="cross-staff-finding-withdraw"
                      onClick={() =>
                        onWithdraw({ kind: first.kind, part: standing.part })
                      }
                      className="ml-2 underline underline-offset-2 hover:text-slate-700 dark:hover:text-slate-300"
                    >
                      Undo
                    </button>
                  )}
                </p>
              );
            })()}
            <ul className="mt-1 space-y-0.5 text-slate-600 dark:text-slate-400">
              {group.slice(0, 4).map((entry, index) => (
                <li
                  key={`${kind}-${entry.engineId}-${entry.index}-${index}`}
                  data-testid="cross-staff-finding-item"
                >
                  {entry.finding.system !== undefined
                    ? `System ${entry.finding.system + 1}: `
                    : ""}
                  {entry.finding.part ? `${entry.finding.part} — ` : ""}
                  {entry.finding.message}
                  {canLocate && isLocatable(entry.finding) && (
                    <FindingCrop
                      jobId={jobId!}
                      pageNumber={pageNumber!}
                      statusVersion={statusVersion!}
                      located={entry}
                    />
                  )}
                  {editorUrlFor && (
                    <a
                      data-testid="cross-staff-finding-fix"
                      href={editorUrlFor(entry.engineId, {
                        kind: entry.finding.kind,
                        ...(entry.finding.part ? { part: entry.finding.part } : {}),
                      })}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-2 text-xs font-medium text-sky-700 underline underline-offset-2 hover:text-sky-900 dark:text-sky-400 dark:hover:text-sky-300"
                    >
                      Fix the reading
                    </a>
                  )}
                </li>
              ))}
              {group.length > 4 && (
                <li className="text-slate-400">
                  …and {group.length - 4} more like it
                </li>
              )}
            </ul>
            {onDecide &&
              !dispositionFor(group[0].finding, dispositions || []) &&
              (() => {
                const first = group[0].finding;
                const amendment = amendmentFor(first);
                // Decided for the whole kind and part at once, never per page: the same
                // disagreement recurs on every page of a movement, and asking per page
                // trains reviewers to dismiss the category unread.
                const part = first.part ?? null;
                return (
                  <div className="mt-2 flex flex-wrap gap-3">
                    {amendment && (
                      <button
                        type="button"
                        data-testid="cross-staff-finding-amend"
                        onClick={() =>
                          onDecide({
                            kind: first.kind,
                            part,
                            disposition: "profile-amended",
                            amendment,
                          })
                        }
                        className="text-xs font-medium text-sky-700 underline underline-offset-2 hover:text-sky-900 dark:text-sky-400"
                      >
                        Expected — widen the profile to {amendment.addClefs.join(", ")}
                      </button>
                    )}
                    <button
                      type="button"
                      data-testid="cross-staff-finding-acknowledge"
                      onClick={() =>
                        onDecide({ kind: first.kind, part, disposition: "acknowledged" })
                      }
                      className="text-xs font-medium text-slate-600 underline underline-offset-2 hover:text-slate-900 dark:text-slate-400"
                    >
                      Checked — reads correctly
                    </button>
                    <button
                      type="button"
                      data-testid="cross-staff-finding-flag"
                      onClick={() =>
                        onDecide({ kind: first.kind, part, disposition: "reading-flagged" })
                      }
                      className="text-xs font-medium text-amber-700 underline underline-offset-2 hover:text-amber-900 dark:text-amber-500"
                    >
                      Misread — flag it
                    </button>
                  </div>
                );
              })()}
          </li>
        ))}
      </ul>
    </section>
  );
}
