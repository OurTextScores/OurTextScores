import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * A bar a human rewrote after one engine flagged its own reading.
 *
 * Design: `docs/private/SCANNER_FINDINGS_REVIEW_EDITOR_DESIGN_2026-09-10.md`.
 *
 * **Why not a `ScannerMergeDecision`.** That record exists because "two independent
 * readings disagreed, and here is which one a human believed" - the signal spot review
 * cannot produce. A cross-staff finding is one engine's own consistency check, and
 * findings live on single-engine jobs, where `baseEngineId` and `candidateEngineId`
 * collapse to the same engine and the record asserts a disagreement that never happened.
 *
 * **Why not a `ScannerCorrection`.** That record is symbol-level: `staffIndex`,
 * `symbolIndex`, `head`, `predicted`, `predictedConfidence`, `chosen`. A bar-level
 * MusicXML edit has none of those, and filling required fields with sentinels to make it
 * fit would put fiction in the corpus these collections exist to keep honest.
 *
 * So: its own shape, matching its own claim. One engine produced this page, that engine
 * flagged itself, and a human rewrote these bars. It credits nobody and accuses nobody
 * else.
 *
 * Keyed on `pageSha256` like its two neighbours, because it has to outlive the job:
 * jobs and their artifacts expire, and a page reviewed without a durable record is
 * training data destroyed.
 */
@Schema({ collection: 'scanner_finding_edits', timestamps: true })
export class ScannerFindingEdit {
  /** Identifies the page image, so edits survive re-scans and job expiry. */
  @Prop({ required: true, index: true })
  pageSha256!: string;

  @Prop({ required: true, index: true })
  userHash!: string;

  /** The engine that produced the reading and raised the finding. Exactly one. */
  @Prop({ required: true, index: true })
  engineId!: string;

  /** The finding kind that prompted the edit, e.g. `clef_profile_mismatch`. */
  @Prop({ required: true, index: true })
  findingKind!: string;

  /** The profile part, when the finding named one. */
  @Prop()
  part?: string;

  /** The merged-document bar that was rewritten. */
  @Prop({ required: true })
  measureIndex!: number;

  @Prop()
  stablePartKey?: string;

  /** Binds the edit to the exact reading it answers. */
  @Prop()
  contentSignature?: string;

  @Prop()
  engineArtifactSha256?: string;

  /** A sample is meaningless without the model that produced it. */
  @Prop()
  modelRevision?: string;

  @Prop()
  providerRevision?: string;

  /**
   * Which score-profile revision the page was decoded against.
   *
   * A finding raised under a narrow profile and one raised under a widened one are
   * different events, and only this separates them.
   */
  @Prop()
  scoreProfileRevision?: number;

  /**
   * Which published terms were in force when this was captured.
   *
   * Scans uploaded under a promise that they would not be used for training must not
   * become training data because the page changed later.
   */
  @Prop({ required: true, index: true })
  policyVersion!: string;
}

export type ScannerFindingEditDocument = HydratedDocument<ScannerFindingEdit>;
export const ScannerFindingEditSchema = SchemaFactory.createForClass(ScannerFindingEdit);
ScannerFindingEditSchema.index({ pageSha256: 1, engineId: 1, findingKind: 1 });
