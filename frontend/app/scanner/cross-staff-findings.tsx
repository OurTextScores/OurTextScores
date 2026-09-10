import type { ScannerCrossStaffFinding } from "./scanner-types";

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

export function CrossStaffFindings({
  findings,
}: {
  findings: ScannerCrossStaffFinding[];
}) {
  if (findings.length === 0) return null;

  // Grouped by kind so eleven repetitions of one disagreement read as one thing with a
  // count, rather than eleven rows that bury everything else.
  const byKind = new Map<string, ScannerCrossStaffFinding[]>();
  for (const finding of findings) {
    byKind.set(finding.kind, [...(byKind.get(finding.kind) ?? []), finding]);
  }

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
        {[...byKind.entries()].map(([kind, group]) => (
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
            <ul className="mt-1 space-y-0.5 text-slate-600 dark:text-slate-400">
              {group.slice(0, 4).map((finding, index) => (
                <li key={`${kind}-${finding.system ?? "page"}-${index}`}>
                  {finding.system !== undefined
                    ? `System ${finding.system + 1}: `
                    : ""}
                  {finding.part ? `${finding.part} — ` : ""}
                  {finding.message}
                </li>
              ))}
              {group.length > 4 && (
                <li className="text-slate-400">
                  …and {group.length - 4} more like it
                </li>
              )}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
