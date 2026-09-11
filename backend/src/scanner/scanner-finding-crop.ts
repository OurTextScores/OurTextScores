import { CropRect, padAndClamp } from './scanner-crop';

/**
 * Where on the page a cross-staff finding is talking about.
 *
 * Design: `docs/private/SCANNER_FINDINGS_REVIEW_EDITOR_DESIGN_2026-09-10.md`.
 *
 * The design's first task was to prove that a finding's `system` can be joined to real
 * geometry, and warned that joining it to the *comparison* payload's `systemIndex` would
 * be trusting two indices from different producers to agree. Checking against a real job
 * settled it, and against a different answer than the design assumed:
 *
 * - The comparison payload is the wrong source. It does not exist on a single-engine
 *   job, and single-engine is exactly where findings live — the job that motivated this
 *   ran `ots-homr` alone and has no comparison at all.
 * - The right source is the engine's own `review.staves`, where each staff already
 *   carries both `systemIndex` and `region`. Finding and geometry then come out of the
 *   same HOMR pass, so the correspondence holds by construction rather than by
 *   coincidence — there is no cross-origin index to distrust.
 *
 * Verified on job `cc2ce56d` (quartet profile, presto4): all 11 finding system indices
 * resolved, none dangling. That page is also the Phase 7 defect — HOMR reported 11
 * one-staff "systems" where the page has a handful of four-staff ones — which is the
 * useful case to have proven, since a crop has to stay honest on exactly the pages whose
 * segmentation is wrong. It does: the crop shows the strip HOMR called a system, which is
 * the evidence the reviewer needs in order to see that the segmentation is wrong.
 *
 * Coordinates are `recognitionRaster` space, not the source image. On that job the staff
 * regions ran from x=-12 to x=1009 on a 1007px-wide raster and needed clamping on every
 * side, so nothing here may assume a region is already inside the page.
 */

/** One staff of `review.staves`; only the fields this join needs. */
export interface FindingStaff {
  index: number;
  systemIndex: number;
  region: number[];
  partIndex?: number;
}

/** Only the fields of a cross-staff finding that bear on where it points. */
export interface LocatableFinding {
  kind: string;
  system?: number;
  /** Positions *within* the system, top to bottom - never page-wide staff numbers. */
  staffIndices?: number[];
  part?: string;
}

export type FindingCropLevel = 'staff' | 'system' | 'none';

export type FindingCropReason =
  /** The finding is about the page, not a system - `page_staff_count_mismatch` and
   *  `part_order_mismatch` are raised with no `system` at all. */
  | 'page-level'
  /** A system index with no matching staff. Refuse rather than guess: one music system
   *  looks much like the one below it, so a wrong crop is not self-evident. */
  | 'unknown-system'
  /** Positions outside the system's own staves. Falls back to the system crop, which is
   *  coarse but correct, rather than banding somewhere arbitrary. */
  | 'staff-index-out-of-range';

export interface FindingCrop {
  level: FindingCropLevel;
  /** Absent only when `level` is `none`. */
  rect?: CropRect;
  /** The staves the crop covers, by their page-wide `index`. */
  staffIndexes: number[];
  /** Present whenever the answer is not a clean staff-level band. */
  reason?: FindingCropReason;
}

function union(regions: number[][]): number[] {
  return [
    Math.min(...regions.map((r) => Math.min(r[0], r[2]))),
    Math.min(...regions.map((r) => Math.min(r[1], r[3]))),
    Math.max(...regions.map((r) => Math.max(r[0], r[2]))),
    Math.max(...regions.map((r) => Math.max(r[1], r[3])))
  ];
}

function usable(staff: FindingStaff): boolean {
  return (
    Array.isArray(staff?.region) &&
    staff.region.length === 4 &&
    staff.region.every((coordinate) => Number.isFinite(coordinate))
  );
}

/**
 * The rectangle to show for one finding, or `none` with a reason.
 *
 * Never guesses. Every degraded answer is labelled, because the alternative - a crop that
 * silently lands somewhere plausible but wrong - is indistinguishable from a correct one
 * to the reviewer looking at it.
 */
export function findingCrop(
  finding: LocatableFinding,
  staves: FindingStaff[],
  raster: { width: number; height: number },
  padding = 12
): FindingCrop {
  if (!Number.isInteger(finding?.system)) {
    return { level: 'none', staffIndexes: [], reason: 'page-level' };
  }

  const inSystem = (staves || [])
    .filter((staff) => staff?.systemIndex === finding.system && usable(staff))
    .sort((first, second) => first.index - second.index);

  if (inSystem.length === 0) {
    return { level: 'none', staffIndexes: [], reason: 'unknown-system' };
  }

  const systemCrop = (reason?: FindingCropReason): FindingCrop => ({
    level: 'system',
    rect: padAndClamp(union(inSystem.map((staff) => staff.region)), padding, raster),
    staffIndexes: inSystem.map((staff) => staff.index),
    ...(reason ? { reason } : {})
  });

  const positions = finding.staffIndices;
  if (!Array.isArray(positions) || positions.length === 0) {
    return systemCrop();
  }

  // `staffIndices` are positions within this system, so they index `inSystem` - not the
  // page-wide staff list. Conflating the two is the mistake this comment exists to stop.
  const banded = positions
    .filter((position) => Number.isInteger(position))
    .map((position) => inSystem[position])
    .filter((staff): staff is FindingStaff => staff !== undefined);

  if (banded.length !== positions.length) {
    return systemCrop('staff-index-out-of-range');
  }

  return {
    level: 'staff',
    rect: padAndClamp(union(banded.map((staff) => staff.region)), padding, raster),
    staffIndexes: banded.map((staff) => staff.index)
  };
}
