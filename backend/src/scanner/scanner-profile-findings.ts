/**
 * `profile_layout_deviation: profile expects E staff(s) per system, detected geometry implies D` is a false
 * alarm when D is the profile's staff total with each grand staff counted as one unit: the recogniser merges
 * a piano's two staves into one decoded staff (its tokens carry both hands), while the profile counts physical
 * staves. Providers whose recogniser predates the fix still send it, so it is dropped here. A count that fits
 * neither reading is a real deviation and stays.
 */
export function isMergedGrandStaffDeviation(
  finding: Record<string, unknown>,
  profile?: { parts?: { expectedStaffCount?: number }[] }
): boolean {
  if (finding?.kind !== 'profile_layout_deviation' || typeof finding.message !== 'string')
    return false;
  const match = /expects (\d+) staff\(s\) per system, detected geometry implies (\d+)/.exec(
    finding.message
  );
  if (!match || !profile?.parts?.length) return false;
  const counts = profile.parts.map((part) => Math.max(0, part.expectedStaffCount ?? 1));
  const physical = counts.reduce((sum, count) => sum + count, 0);
  const merged = counts.reduce((sum, count) => sum + Math.ceil(count / 2), 0);
  return merged !== physical && Number(match[1]) === physical && Number(match[2]) === merged;
}
