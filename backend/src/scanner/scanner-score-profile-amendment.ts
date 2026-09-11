import { ScannerScoreProfile, ScannerScoreProfilePart } from './scanner-dual-engine';

/**
 * Widening a score profile in response to a finding.
 *
 * Design: `docs/private/SCANNER_FINDINGS_REVIEW_EDITOR_DESIGN_2026-09-10.md`.
 *
 * A reviewer who sees "cello reads in tenor, profile expects bass" has two honest
 * answers, and this is the one where the profile was wrong rather than the reading. The
 * cello genuinely uses three clefs; the expectation was too narrow.
 *
 * **Widen, never replace.** `likelyClefs: ['F4']` becomes `['F4', 'C4']`, never `['C4']`.
 * The profile is documented as "a prior a reviewer can see and reject, never an assertion
 * the pipeline enforces", and replacing would turn a corrected expectation into a new
 * narrow one - the next page that legitimately uses the original clef would raise the
 * mirror-image finding, and a reviewer could ping-pong between them forever.
 *
 * **Version, never mutate.** The profile is fingerprinted into the provider's idempotency
 * key (`scoreProfileFingerprint`), so amending mid-job means earlier pages were decoded
 * against revision N and later pages against N+1. That is the intended effect - the
 * finding should stop recurring - but it makes the job heterogeneous, and a page that
 * cannot say which prior it saw cannot be reproduced or explained. Every amendment
 * therefore produces a new revision and leaves the old one intact.
 *
 * Order is never touched. `canonicalScoreProfileJson` preserves part order deliberately:
 * "a profile is an ordered set, top to bottom the way a score prints, and reordering it
 * describes a different score." Widening one part must not resort the list.
 */

export interface ProfileAmendment {
  /** The part to widen. Job-scoped, matching `ScannerScoreProfilePart.stableId`. */
  stableId: string;
  /** Clefs to add to `likelyClefs`. Existing entries are kept and not reordered. */
  addClefs?: string[];
  /** Widen the expected staff count; only ever upward. */
  expectedStaffCount?: number;
}

export class ProfileAmendmentError extends Error {}

/** One stored revision of a job's profile. */
export interface ScoreProfileRevision {
  revision: number;
  profile: ScannerScoreProfile;
  /** Why it changed; absent on the original the user supplied. */
  amendment?: ProfileAmendment;
  userHash?: string;
  createdAt?: Date;
}

function widenPart(
  part: ScannerScoreProfilePart,
  amendment: ProfileAmendment
): ScannerScoreProfilePart {
  const existing = part.likelyClefs ?? [];
  // Order-preserving union: existing clefs keep their positions and their relative
  // priority, new ones are appended. `likelyClefs` is read as a preference order.
  const added = (amendment.addClefs ?? []).filter(
    (clef) => typeof clef === 'string' && clef.length > 0 && !existing.includes(clef)
  );
  const likelyClefs = added.length > 0 ? [...existing, ...added] : part.likelyClefs;

  const expectedStaffCount =
    amendment.expectedStaffCount === undefined
      ? part.expectedStaffCount
      : Math.max(part.expectedStaffCount ?? 0, amendment.expectedStaffCount);

  return {
    ...part,
    ...(likelyClefs === undefined ? {} : { likelyClefs }),
    ...(expectedStaffCount === undefined ? {} : { expectedStaffCount })
  };
}

/**
 * The profile that results from widening one part, or the same object if nothing changed.
 *
 * Returning the identical reference on a no-op is load-bearing: `amendProfile` is what
 * decides whether a new revision is needed, and minting a revision that produces
 * byte-identical canonical JSON would change the idempotency key for no reason and
 * re-decode every remaining page to reach the same answer.
 */
export function widenProfile(
  profile: ScannerScoreProfile,
  amendment: ProfileAmendment
): ScannerScoreProfile {
  if (!profile || !Array.isArray(profile.parts)) {
    throw new ProfileAmendmentError('profile has no parts to amend');
  }
  const index = profile.parts.findIndex((part) => part.stableId === amendment?.stableId);
  if (index < 0) {
    // Refuse rather than append a part. A stableId the profile does not know is either a
    // stale client or a bug, and inventing a part would silently change what the score is
    // declared to be.
    throw new ProfileAmendmentError(`profile has no part "${amendment?.stableId}"`);
  }

  const widened = widenPart(profile.parts[index], amendment);
  const unchanged =
    JSON.stringify(widened) === JSON.stringify(profile.parts[index]);
  if (unchanged) return profile;

  const parts = [...profile.parts];
  parts[index] = widened;
  return { ...profile, parts };
}

/**
 * Append a revision, or return the history unchanged when the amendment is a no-op.
 *
 * The caller can tell which happened by identity, and should only re-stamp pages and
 * change the provider fingerprint when the history actually grew.
 */
export function amendProfile(
  history: ScoreProfileRevision[],
  amendment: ProfileAmendment,
  userHash: string,
  now: Date = new Date()
): ScoreProfileRevision[] {
  if (!Array.isArray(history) || history.length === 0) {
    throw new ProfileAmendmentError('no profile to amend');
  }
  const current = currentRevision(history);
  const widened = widenProfile(current.profile, amendment);
  if (widened === current.profile) return history;

  return [
    ...history,
    {
      revision: current.revision + 1,
      profile: widened,
      amendment,
      userHash,
      createdAt: now
    }
  ];
}

/** The live revision: the highest, not the last written. */
export function currentRevision(history: ScoreProfileRevision[]): ScoreProfileRevision {
  if (!Array.isArray(history) || history.length === 0) {
    throw new ProfileAmendmentError('profile history is empty');
  }
  return history.reduce((best, entry) => (entry.revision > best.revision ? entry : best));
}

/** The original profile as supplied, for showing what the reviewer changed. */
export function originalRevision(history: ScoreProfileRevision[]): ScoreProfileRevision {
  if (!Array.isArray(history) || history.length === 0) {
    throw new ProfileAmendmentError('profile history is empty');
  }
  return history.reduce((best, entry) => (entry.revision < best.revision ? entry : best));
}


/**
 * Where a job's profile revisions live, and why not in the engine plan.
 *
 * `ScannerOtsHomrEngineOptions` is documented as "Immutable, user-selected policy for one
 * OTS-HOMR engine run", and `scannerEnginePlanForJob` rejects any key outside
 * `textDetector` and `scoreProfile`. Both are deliberate. So revisions are stored beside
 * the plan rather than inside it, and the plan keeps meaning exactly what it says: what
 * the *user* chose when the job was created.
 *
 * That split is worth more than the storage convenience. After three amendments a
 * reviewer still needs to see what was originally claimed about the score, and a plan
 * that had been edited three times could not tell them.
 */
export interface HasScoreProfileRevisions {
  enginePlan?: { engineOptions?: Record<string, unknown> };
  scoreProfileRevisions?: ScoreProfileRevision[];
}

function planProfile(job: HasScoreProfileRevisions): ScannerScoreProfile | undefined {
  const options = job?.enginePlan?.engineOptions?.['ots-homr'] as
    | { scoreProfile?: ScannerScoreProfile }
    | undefined;
  return options?.scoreProfile;
}

/**
 * The profile a page decoded now would actually be given, and which revision that is.
 *
 * Undefined when the job has no profile at all - most jobs. A job that never supplied
 * one must not acquire an empty profile here, because an empty profile is not the same
 * as no profile: it would claim the score has no parts.
 */
export function effectiveScoreProfile(
  job: HasScoreProfileRevisions
): { profile: ScannerScoreProfile; revision: number } | undefined {
  if (Array.isArray(job?.scoreProfileRevisions) && job.scoreProfileRevisions.length > 0) {
    const current = currentRevision(job.scoreProfileRevisions);
    return { profile: current.profile, revision: current.revision };
  }
  const original = planProfile(job);
  // Revision 1 is the plan's own profile, whether or not history has been written yet.
  // Seeding lazily means every job created before this existed still reports a coherent
  // revision rather than none, and no migration is needed.
  return original ? { profile: original, revision: 1 } : undefined;
}

/**
 * The history to amend, seeded from the plan on first use.
 *
 * Separate from `amendProfile` so that seeding is explicit: a caller that stored a seeded
 * history without amending anything would write a revision nobody asked for.
 */
export function ensureScoreProfileHistory(
  job: HasScoreProfileRevisions
): ScoreProfileRevision[] {
  if (Array.isArray(job?.scoreProfileRevisions) && job.scoreProfileRevisions.length > 0) {
    return job.scoreProfileRevisions;
  }
  const original = planProfile(job);
  if (!original) {
    throw new ProfileAmendmentError('job has no score profile to amend');
  }
  return [{ revision: 1, profile: original }];
}


/**
 * The engine options a run should actually be given, with the live profile substituted.
 *
 * Every site that builds an idempotency key or calls the provider must go through this.
 * There are two such sites in the worker - the normal path and the orphan-recovery path -
 * and they have to agree: recovery re-derives the key to decide whether a call already
 * happened, so if one used the amended profile and the other the original, recovery would
 * compute a different key and re-run a page that had already succeeded.
 *
 * Returns the identical object when nothing was amended, so an unamended job produces
 * byte-identical options and therefore the same fingerprint it always did.
 */
export function effectiveEngineOptions(
  job: HasScoreProfileRevisions,
  engineId: string
): Record<string, unknown> | undefined {
  const options = job?.enginePlan?.engineOptions?.[engineId] as
    | Record<string, unknown>
    | undefined;
  // Engines without a profile - and jobs without one - pass straight through. Adding a
  // profile here would hand a prior to a run the user never gave one to.
  if (!options || options.scoreProfile === undefined) return options;
  const effective = effectiveScoreProfile(job);
  if (!effective || effective.profile === options.scoreProfile) return options;
  return { ...options, scoreProfile: effective.profile };
}
