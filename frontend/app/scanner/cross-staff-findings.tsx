"use client";

import { useCallback, useEffect, useState } from "react";
import type { ScannerCrossStaffFinding } from "./scanner-types";

/**
 * What a reader is being told, and what they can do about it.
 *
 * A profile is a prior supplied by a human who may be wrong about which edition they
 * uploaded, so a clef finding has two honest readings and the surface has to offer
 * both: the recognition is wrong, or the profile is. Neither is the default.
 */
const KIND_COPY: Record<string, { title: string; profileMayBeWrong: boolean }> =
  {
    clef_profile_mismatch: {
      title: "Clef differs from the expected part",
      profileMayBeWrong: true,
    },
    profile_layout_deviation: {
      title: "System has a different number of staves than expected",
      profileMayBeWrong: true,
    },
    time_signature_mismatch: {
      title: "Staves disagree on time signature",
      profileMayBeWrong: false,
    },
    key_signature_mismatch: {
      title: "Staves disagree on key signature",
      profileMayBeWrong: false,
    },
    measure_count_mismatch: {
      title: "Staves disagree on bar count",
      profileMayBeWrong: false,
    },
    part_order_mismatch: {
      title: "Parts appear in an unexpected order",
      profileMayBeWrong: true,
    },
  };

function describe(kind: string) {
  return (
    KIND_COPY[kind] ?? {
      title: kind.replace(/_/g, " "),
      profileMayBeWrong: false,
    }
  );
}

/**
 * A finding's identity for dismissal purposes: its kind and the part it concerns.
 *
 * Deliberately not per-page or per-system. A quartet whose cello reads in tenor raises
 * the same finding on every page of the movement, and a surface that asked about each
 * one separately would train reviewers to dismiss the whole category without reading
 * it. Dismissing once means "the profile is wrong about this part", which is a fact
 * about the score rather than about a page.
 */
export function dismissalKey(finding: ScannerCrossStaffFinding): string {
  return `${finding.kind}:${finding.part ?? "*"}`;
}

const STORAGE_PREFIX = "ots-scanner-findings-dismissed:";

export function CrossStaffFindings({
  jobId,
  findings,
}: {
  jobId: string;
  findings: ScannerCrossStaffFinding[];
}) {
  const storageKey = `${STORAGE_PREFIX}${jobId}`;
  const [dismissed, setDismissed] = useState<string[]>([]);

  // Read on mount rather than during render: the server has no idea what this reader
  // has dismissed, so deriving it earlier would hydrate into a mismatch.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored) setDismissed(JSON.parse(stored) as string[]);
    } catch {
      // A reader with storage disabled sees every finding, which is the safe way to
      // fail: a finding shown twice is noise, one silently hidden is a lost review.
    }
  }, [storageKey]);

  const dismiss = useCallback(
    (key: string) => {
      setDismissed((current) => {
        const next = current.includes(key) ? current : [...current, key];
        try {
          window.localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          // Not persisted; still hidden for this visit.
        }
        return next;
      });
    },
    [storageKey],
  );

  const visible = findings.filter(
    (finding) => !dismissed.includes(dismissalKey(finding)),
  );
  if (findings.length === 0) return null;

  return (
    <section
      data-testid="cross-staff-findings"
      className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900/60"
    >
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
        Things worth a look
      </h3>
      <p className="mt-1 text-xs text-slate-500">
        Disagreements between staves, and between the score and what you said to
        expect. None of them block anything — the page is complete either way.
      </p>
      {visible.length === 0 ? (
        <p
          className="mt-3 text-xs text-slate-500"
          data-testid="findings-all-dismissed"
        >
          All dismissed for this scan.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {visible.map((finding, index) => {
            const { title, profileMayBeWrong } = describe(finding.kind);
            return (
              <li
                key={`${dismissalKey(finding)}-${finding.system ?? "page"}-${index}`}
                data-testid="cross-staff-finding"
                data-kind={finding.kind}
                className="rounded border border-slate-200 bg-white p-3 text-xs dark:border-slate-700 dark:bg-slate-900"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium text-slate-900 dark:text-slate-100">
                    {title}
                    {finding.part ? ` · ${finding.part}` : ""}
                    {finding.system !== undefined
                      ? ` · system ${finding.system + 1}`
                      : ""}
                  </span>
                  <button
                    type="button"
                    data-testid="btn-dismiss-finding"
                    onClick={() => dismiss(dismissalKey(finding))}
                    className="rounded border border-slate-300 px-2 py-0.5 text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300"
                  >
                    {profileMayBeWrong
                      ? "Expected — the score really is like this"
                      : "Dismiss"}
                  </button>
                </div>
                <p className="mt-1 text-slate-600 dark:text-slate-400">
                  {finding.message}
                </p>
                {profileMayBeWrong && (
                  <p className="mt-1 text-[11px] text-slate-500">
                    Dismissing hides this for {finding.part ?? "this kind"}{" "}
                    across the whole scan.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
