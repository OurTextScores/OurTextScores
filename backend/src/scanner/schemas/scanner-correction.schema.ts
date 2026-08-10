import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * A reviewer's decision about one uncertain spot, kept for model training.
 *
 * Separate from the job because it has to outlive it: jobs and their artifacts
 * expire, and every page reviewed without a durable record is training data
 * destroyed. Keyed on the page image's own hash rather than the job, so
 * re-scanning the same page joins the same history instead of orphaning it.
 *
 * Nothing here reproduces the score. The crop is referenced, not stored, and
 * the record carries symbol identity rather than content — the same reasoning
 * as the telemetry allow-list.
 */
@Schema({ collection: 'scanner_corrections', timestamps: true })
export class ScannerCorrection {
  /** Identifies the page image, so corrections survive re-scans and job expiry. */
  @Prop({ required: true, index: true })
  pageSha256!: string;

  @Prop({ required: true, index: true })
  userHash!: string;

  @Prop({ required: true })
  staffIndex!: number;

  @Prop({ required: true })
  symbolIndex!: number;

  /** Which of the decoder's six heads this decision was about. */
  @Prop({ required: true })
  head!: string;

  @Prop({ required: true })
  predicted!: string;

  @Prop({ required: true })
  predictedConfidence!: number;

  /** What the model offered, so a retrain can see the choice as posed. */
  @Prop({ type: [{ value: String, confidence: Number }], default: [] })
  offered!: Array<{ value: string; confidence: number }>;

  @Prop({ required: true })
  chosen!: string;

  /**
   * `confirmed` is as valuable as `corrected`: a reviewer agreeing with a 61%
   * prediction says the model was right but unsure, which is exactly the sample
   * that improves calibration.
   */
  @Prop({ required: true, enum: ['confirmed', 'corrected'], index: true })
  outcome!: 'confirmed' | 'corrected';

  /**
   * A correction is only meaningful against the model that produced it.
   * Without these a retrain cannot tell which samples came from which revision.
   */
  @Prop({ required: true })
  homrRevision!: string;

  @Prop({ required: true })
  providerRevision!: string;

  /**
   * Which published terms were in force when this was captured.
   *
   * Scans uploaded under a promise that they would not be used for training
   * must not become training data because the page changed later. Recording the
   * version at capture time is the only way to tell those apart afterwards.
   */
  @Prop({ required: true, index: true })
  policyVersion!: string;
}

export type ScannerCorrectionDocument = HydratedDocument<ScannerCorrection>;
export const ScannerCorrectionSchema = SchemaFactory.createForClass(ScannerCorrection);
ScannerCorrectionSchema.index({ pageSha256: 1, staffIndex: 1, symbolIndex: 1, head: 1 });
