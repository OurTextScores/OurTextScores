import {
  ScannerFindingDisposition,
  suppressesFinding
} from './schemas/scanner-finding-disposition.schema';

/**
 * Applying standing review decisions to the findings a page produced.
 *
 * Design: `docs/private/SCANNER_FINDINGS_REVIEW_EDITOR_DESIGN_2026-09-10.md`.
 *
 * Pure, and separate from the collection it reads, for the same reason `fusion_policy` is
 * free of the web stack: the rules are the part that has to be right, and a rule about
 * which decision beats which should be testable without a database.
 *
 * Suppression is a *view* over the findings, never a deletion. The findings stay exactly
 * as the engine reported them; this decides what a reviewer is shown as open work and
 * what is answered, and every answered finding stays reachable behind a count.
 */

/** Only the fields of a finding that a disposition matches on. */
export interface DispositionableFinding {
  kind: string;
  part?: string;
}

export interface StandingDisposition {
  kind: string;
  /** `null` means every part of this kind. */
  part: string | null;
  disposition: ScannerFindingDisposition;
  updatedAt?: Date;
}

export interface DispositionedFinding<T extends DispositionableFinding> {
  finding: T;
  /** Absent when no standing decision covers this finding. */
  disposition?: ScannerFindingDisposition;
  /** The decision's own part, so the UI can say "all parts" rather than imply this one. */
  matchedPart?: string | null;
  suppressed: boolean;
}

export interface DispositionSummary<T extends DispositionableFinding> {
  findings: DispositionedFinding<T>[];
  openCount: number;
  suppressedCount: number;
  flaggedCount: number;
}

/**
 * The standing decision covering one finding, or undefined.
 *
 * **Part-specific beats kind-wide.** A reviewer who has said "expected for the cello"
 * and later says "the reading is wrong, all parts" must not have the cello decision
 * silently overturned, and vice versa - the narrower statement is the more considered
 * one, and is the one a reviewer would be surprised to lose.
 *
 * A finding with no part can only ever be matched by a kind-wide decision. Falling back
 * to some arbitrary part's decision would apply a judgement about the cello to a slur
 * that was never attributed to any part.
 */
export function dispositionFor(
  finding: DispositionableFinding,
  dispositions: StandingDisposition[]
): StandingDisposition | undefined {
  const forKind = (dispositions || []).filter((entry) => entry?.kind === finding?.kind);
  if (finding?.part !== undefined && finding.part !== null) {
    const specific = forKind.find((entry) => entry.part === finding.part);
    if (specific) return specific;
  }
  return forKind.find((entry) => entry.part === null || entry.part === undefined);
}

export function applyDispositions<T extends DispositionableFinding>(
  findings: T[],
  dispositions: StandingDisposition[]
): DispositionSummary<T> {
  const decided = (findings || []).map((finding) => {
    const standing = dispositionFor(finding, dispositions);
    return {
      finding,
      ...(standing
        ? { disposition: standing.disposition, matchedPart: standing.part ?? null }
        : {}),
      suppressed: standing ? suppressesFinding(standing.disposition) : false
    } as DispositionedFinding<T>;
  });

  return {
    findings: decided,
    // A flagged finding is open work, not answered work: someone said the reading is
    // wrong and nobody has fixed it yet. Counting it as handled would lose the only
    // record that anything is wrong.
    openCount: decided.filter((entry) => !entry.suppressed).length,
    suppressedCount: decided.filter((entry) => entry.suppressed).length,
    flaggedCount: decided.filter((entry) => entry.disposition === 'reading-flagged').length
  };
}
