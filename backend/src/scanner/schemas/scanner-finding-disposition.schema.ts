import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * What a reviewer decided about a class of cross-staff finding on one job.
 *
 * Design: `docs/private/SCANNER_FINDINGS_REVIEW_EDITOR_DESIGN_2026-09-10.md`.
 *
 * **Job-scoped, unlike its two neighbours, and deliberately so.** `ScannerCorrection` and
 * `ScannerMergeDecision` are keyed on `pageSha256` because they are training data that
 * has to outlive the job. This is not training data: it is job state. A profile
 * amendment applies to a `stableId` that is itself job-scoped, and a suppression is a
 * statement about this scan's review, not about the page in general. Keying it on the
 * page would carry one reviewer's "expected, don't show me again" onto an unrelated
 * future scan of the same image.
 *
 * The training signal lives elsewhere on purpose. "The reading is wrong" earns a durable
 * page-keyed record through the existing correction path when the reviewer actually fixes
 * it. "My own profile was too narrow" earns nothing: it says something about the user's
 * input, not about the model, and storing it as training data would pollute the corpus
 * the other two collections exist to build.
 *
 * **Keyed by kind and part, never by page.** The same disagreement recurs on every page
 * of a movement. Asking per page trains reviewers to dismiss the category unread, which
 * is the opposite of what a review surface is for.
 */
export type ScannerFindingDisposition =
  /** The profile was too narrow and has been widened; this is no longer a disagreement. */
  | 'profile-amended'
  /** Seen, understood, genuinely fine as read. */
  | 'acknowledged'
  /** The reading is wrong. Marks the finding; does NOT hide it. */
  | 'reading-flagged';

export const SCANNER_FINDING_DISPOSITIONS: ScannerFindingDisposition[] = [
  'profile-amended',
  'acknowledged',
  'reading-flagged'
];

/**
 * Which dispositions stop the finding being shown as open work.
 *
 * `reading-flagged` is deliberately absent. A flagged finding is a real, unresolved
 * problem; hiding it on the grounds that someone has noticed it would lose the only
 * record that anything is wrong. Suppression here means "answered", not "seen".
 */
export const SCANNER_SUPPRESSING_DISPOSITIONS: ScannerFindingDisposition[] = [
  'profile-amended',
  'acknowledged'
];

export function suppressesFinding(disposition: ScannerFindingDisposition): boolean {
  return SCANNER_SUPPRESSING_DISPOSITIONS.includes(disposition);
}

@Schema({ collection: 'scanner_finding_dispositions', timestamps: true })
export class ScannerFindingDisposition_ {
  @Prop({ required: true, index: true })
  jobId!: string;

  /** The finding kind, e.g. `clef_profile_mismatch`. Not an enum: a new check must be
   *  dispositionable the day it ships, not after a migration. */
  @Prop({ required: true })
  kind!: string;

  /**
   * The profile part this applies to, or `null` for every part.
   *
   * Explicitly `null` rather than absent so the unique index below behaves the same for
   * findings that carry no part - and many do not. `dangling_slur_start` is raised with
   * staff positions and no part at all.
   */
  @Prop({ type: String, default: null })
  part!: string | null;

  @Prop({ required: true, enum: SCANNER_FINDING_DISPOSITIONS })
  disposition!: ScannerFindingDisposition;

  /** Who decided, by the same salted hash the rest of the scanner uses. */
  @Prop({ required: true, index: true })
  userHash!: string;

  /**
   * The profile revision this decision produced, for `profile-amended` only.
   *
   * The profile is fingerprinted into the provider's idempotency key, so amending it
   * mid-job means earlier pages were decoded against revision N and later ones against
   * N+1. That is the intended behaviour - the finding should stop recurring - but it
   * makes the job heterogeneous, and without this nobody can say which prior any given
   * page actually saw.
   */
  @Prop()
  profileRevision?: number;

  /** How many findings of this kind and part were open when the decision was made.
   *  Context for a later reader; never used to re-derive anything. */
  @Prop()
  findingCount?: number;
}

export type ScannerFindingDispositionDocument = HydratedDocument<ScannerFindingDisposition_>;
export const ScannerFindingDispositionSchema = SchemaFactory.createForClass(
  ScannerFindingDisposition_
);

/**
 * One live decision per finding class per job.
 *
 * Unique rather than append-only: simultaneous review is not a supported use case, so
 * there is no concurrent-write story to keep an audit trail for, and `timestamps` already
 * records when the standing decision was last changed. A log would be a second thing to
 * read and reconcile for no reader that exists.
 */
ScannerFindingDispositionSchema.index({ jobId: 1, kind: 1, part: 1 }, { unique: true });
