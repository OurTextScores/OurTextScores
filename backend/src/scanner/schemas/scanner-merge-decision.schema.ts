import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * What a reviewer decided when two engines disagreed, kept for training.
 *
 * Separate from the job for the same reason spot corrections are: jobs and
 * their artifacts expire, and a page reviewed without a durable record is
 * training data destroyed. Keyed on the page image's own hash, so re-scanning
 * the same page joins the same history rather than orphaning it.
 *
 * The point of this record is that a comparison produces a kind of signal spot
 * review cannot. A correction says "the model was unsure and here is the right
 * answer". This says "two independent readings disagreed, and here is which one
 * a human believed" — which is a labelled preference over the exact page both
 * engines saw, and the only place in the product where that exists.
 */
export type ScannerMergeOutcome =
  | 'took-notes'
  | 'took-dynamics'
  | 'took-lyrics'
  | 'removed-bars'
  | 'inserted-bars'
  | 'edited'
  | 'flagged';

/** Outcomes that credit an engine with having read the notes correctly. */
export const SCANNER_NOTE_WIN_OUTCOMES: ScannerMergeOutcome[] = [
  'took-notes',
  'removed-bars',
  'inserted-bars'
];

@Schema({ collection: 'scanner_merge_decisions', timestamps: true })
export class ScannerMergeDecision {
  /** Identifies the page image, so decisions survive re-scans and job expiry. */
  @Prop({ required: true, index: true })
  pageSha256!: string;

  @Prop({ required: true, index: true })
  userHash!: string;

  /** The pair that disagreed, in the order they were compared. */
  @Prop({ required: true })
  baseEngineId!: string;

  @Prop({ required: true })
  candidateEngineId!: string;

  /**
   * The engine credited by this decision, and absent for `edited` or `flagged`.
   *
   * An edited bar is evidence that *both* engines were wrong there. Recording
   * it against either would poison the corpus this feature exists to build, so
   * the field is optional and the service refuses to set it for that outcome.
   */
  @Prop({ index: true })
  engineId?: string;

  @Prop({
    required: true,
    enum: [
      'took-notes',
      'took-dynamics',
      'took-lyrics',
      'removed-bars',
      'inserted-bars',
      'edited',
      'flagged'
    ],
    index: true
  })
  outcome!: ScannerMergeOutcome;

  /** Absent only for a retained client's legacy page-level edit. */
  @Prop()
  blockIndex?: number;

  /** Pair-scoped part and merged bar for hand edits and part-local decisions. */
  @Prop()
  stablePartKey?: string;

  @Prop()
  measureIndex?: number;

  /**
   * Binds the decision to both artifact revisions and the block's own content.
   * Without it a retrain cannot tell which readings the choice was between.
   */
  @Prop()
  contentSignature?: string;

  /**
   * What the two readings disagreed about here.
   *
   * The most directly useful column: "HOMR won when they differed in
   * `notation`" and "Transcoda won when they differed in `attributes`" are
   * different findings, and only this separates them.
   */
  @Prop({ type: [String], default: [] })
  differenceClasses!: string[];

  /** Both readings' artifact checksums, so the exact inputs are recoverable. */
  @Prop()
  baseArtifactSha256?: string;

  @Prop()
  candidateArtifactSha256?: string;

  /** Model and provider identity per engine; a sample is meaningless without. */
  @Prop({ type: Object, default: {} })
  engineRevisions!: Record<string, { modelRevision?: string; providerRevision?: string }>;

  /**
   * What the system changed on its own to make the decision possible.
   *
   * A bar whose slur was dropped is not quite a clean win, and a consumer
   * weighting samples should be able to see that rather than infer it.
   */
  @Prop({ type: [{ code: String, detail: String }], default: [] })
  repairs!: Array<{ code: string; detail: string }>;

  /**
   * Decisions already made on this page when a hand edit was saved. Exact new
   * records also carry `stablePartKey` and `measureIndex`; this field remains
   * useful for sequence context and for legacy page-level edits.
   */
  @Prop()
  priorDecisions?: number;

  /**
   * Which published terms were in force when this was captured.
   *
   * Scans uploaded under a promise that they would not be used for training
   * must not become training data because the page changed later.
   */
  @Prop({ required: true, index: true })
  policyVersion!: string;
}

export type ScannerMergeDecisionDocument = HydratedDocument<ScannerMergeDecision>;
export const ScannerMergeDecisionSchema = SchemaFactory.createForClass(ScannerMergeDecision);
ScannerMergeDecisionSchema.index({ pageSha256: 1, blockIndex: 1, outcome: 1 });
