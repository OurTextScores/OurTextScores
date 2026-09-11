import type { ScannerCrossStaffFinding } from "./scanner-types";

/**
 * The profile amendment that would answer a finding, when one can be derived.
 *
 * "The profile is wrong" is only an actionable decision if it says *how*. The backend
 * refuses an amendment that names no part, so a control offering one has to know both
 * the part and the clef to add before it can honestly be shown.
 *
 * The clef comes out of the finding's own message, which homr builds as:
 *
 *   staff 3 decoded clef 'C3', profile part 'cello' expects one of ['F4', 'C4']
 *
 * Parsing prose is the weak link and is treated as such: the pattern is strict, and a
 * message it does not match yields no amendment and therefore no control, rather than a
 * guess. The durable fix is for the finding to carry the decoded clef as a field; until
 * it does, failing closed keeps a wrong amendment out of the profile.
 */
const DECODED_CLEF = /decoded clef '([A-G][1-9])'/;

export interface FindingAmendment {
  stableId: string;
  addClefs: string[];
}

export function amendmentFor(
  finding: ScannerCrossStaffFinding,
): FindingAmendment | null {
  // Only the clef check produces an amendment today. Widening a staff count from
  // `profile_layout_deviation` would be answering a geometry disagreement by changing
  // what the score is declared to be, which is a different and much stronger claim.
  if (finding.kind !== "clef_profile_mismatch") return null;
  if (!finding.part) return null;
  const matched = DECODED_CLEF.exec(finding.message || "");
  if (!matched) return null;
  return { stableId: finding.part, addClefs: [matched[1]] };
}
