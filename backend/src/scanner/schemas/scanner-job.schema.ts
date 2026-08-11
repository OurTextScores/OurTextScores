import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import type { ScannerEnginePlan, ScannerPageEngines } from '../scanner-dual-engine';

export type ScannerJobDocument = HydratedDocument<ScannerJob>;

export const SCANNER_JOB_STATUSES = [
  'queued',
  'preparing',
  'ready',
  'running',
  'rendering',
  'succeeded',
  'partial',
  'failed',
  'cancelled'
] as const;

export type ScannerJobStatus = (typeof SCANNER_JOB_STATUSES)[number];

export interface ScannerStorageLocator {
  bucket: string;
  objectKey: string;
  sizeBytes: number;
  contentType: string;
  checksumSha256: string;
  /** Versioned digest of the ordered effective-page inputs for a derivative. */
  inputSignature?: string;
}

export interface ScannerSourceInput {
  originalFilename: string;
  storage: ScannerStorageLocator;
}

/**
 * Design section 7.1: the exact engine identity behind a result. The HOMR
 * commit alone is not enough — the weights are versioned separately from it.
 */
export interface ScannerEngineProvenance {
  /** Generic immutable model artifact identity, used by engines other than HOMR too. */
  modelArtifact?: string;
  modelArtifactSha256?: string;
  containerImageDigest?: string;
  converter?: string;
  converterVersion?: string;
  segmentationModel?: string;
  segmentationModelSha256?: string;
  transformerModel?: string;
  encoderModelSha256?: string;
  decoderModelSha256?: string;
  executionProvider?: string;
}

export interface ScannerPageResult {
  pageNumber: number;
  ordinal: number;
  rotationDegrees: 0 | 90 | 180 | 270;
  included: boolean;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';
  /** Provider calls in the current generation; this is what the UI shows. */
  attempts: number;
  /** Provider calls across every generation and worker recovery (13.4). */
  providerAttempts?: number;
  idempotencyKey: string;
  manualRetries?: number;
  sourceImage?: ScannerStorageLocator;
  thumbnail?: ScannerStorageLocator;
  musicXml?: ScannerStorageLocator;
  /** MusicXML produced by dual-engine reconciliation; preferred over spot review. */
  mergedMusicXml?: ScannerStorageLocator;
  /** Phase 0 dual-engine state; legacy top-level HOMR fields remain during migration. */
  engines?: ScannerPageEngines;
  pdf?: ScannerStorageLocator;
  providerRequestId?: string;
  /** Wall-clock time of the provider call, including any cold-start wait. */
  durationMs?: number;
  /** Recognition time inside the provider, excluding cold start (11.3). */
  inferenceMs?: number;
  errorCode?: string;
  errorMessage?: string;
  /**
   * Provider v2 review data, stored raw rather than pre-selected.
   *
   * Which spots to ask a reviewer about is computed on read, so the thresholds
   * can be retuned against real reviewer behaviour without re-scanning the page
   * through a GPU (review design §4, §10). Only the symbols the provider could
   * not rule out are here; a confident page stores almost nothing.
   */
  /** MusicXML rebuilt from corrected tokens; assembly prefers it (Phase D). */
  reviewedMusicXml?: ScannerStorageLocator;
  /**
   * What the reviewer decided, kept alongside what the model predicted and
   * offered. A confirmation of a low-confidence prediction is as much signal as
   * a change, so both outcomes are recorded.
   */
  corrections?: Array<{
    spotId: number;
    head: string;
    predicted: string;
    predictedConfidence: number;
    offered: Array<{ value: string; confidence: number }>;
    chosen: string;
    outcome: 'confirmed' | 'corrected';
    correctedAt: Date;
  }>;
  review?: {
    staves: Array<{
      index: number;
      region?: number[] | null;
      /** The full decoded sequence; a correction edits this, not the XML. */
      tokens?: string[][];
      barLines?: number[];
      symbols: Array<{
        index: number;
        rhythm?: string;
        heads: Record<
          string,
          {
            chosen: string;
            confidence: number;
            alternatives: Array<{ value: string; confidence: number }>;
          }
        >;
        attention?: number[] | null;
      }>;
    }>;
  };
}

@Schema({ collection: 'scanner_jobs', timestamps: true })
export class ScannerJob {
  @Prop({ required: true, unique: true, index: true, trim: true })
  jobId!: string;

  @Prop({ required: true, index: true, trim: true })
  userId!: string;

  @Prop({ required: true, enum: SCANNER_JOB_STATUSES, index: true })
  status!: ScannerJobStatus;

  /**
   * Design section 7.1: incremented on every externally visible change, so a
   * client can tell a stale snapshot from a current one without diffing, and so
   * a later SSE stream has a resume token (section 8.6 `Last-Event-ID`).
   */
  @Prop({ required: true, default: 1 })
  statusVersion!: number;

  @Prop({ required: true, trim: true })
  originalFilename!: string;

  @Prop({ required: true, trim: true })
  inputContentType!: string;

  @Prop({ required: true, min: 1 })
  pageCount!: number;

  // `input` is retained for jobs created before multi-image uploads. New jobs
  // use `inputs`, and the worker reads either representation.
  @Prop({ type: Object })
  input?: ScannerStorageLocator;

  @Prop({ type: [Object], default: [] })
  inputs!: ScannerSourceInput[];

  @Prop({ type: Object, default: {} })
  options!: { detectTitle?: boolean };

  @Prop({ required: true, default: 1 })
  generation!: number;

  @Prop({ type: [Object], default: [] })
  pages!: ScannerPageResult[];

  /** Immutable engine selection and capability semantics for this job. */
  @Prop({ type: Object })
  enginePlan?: ScannerEnginePlan;

  @Prop({ type: [Number] })
  retryPageNumbers?: number[];

  @Prop({ type: Date })
  preparedAt?: Date;

  /** Set when the job enters the provider queue; starts the queue-wait clock. */
  @Prop({ type: Date })
  queuedAt?: Date;

  @Prop({ type: Object })
  musicXmlBundle?: ScannerStorageLocator;

  /** Design section 6: validated whole-score assembly, or an honest reason. */
  @Prop({ type: Object })
  combinedMusicXml?: ScannerStorageLocator;

  /**
   * A correction invalidated the combined score that had already been built.
   * The per-page files stay correct; this stops a stale combined download from
   * being offered as though it included the reviewer's work.
   */
  @Prop({ type: Boolean })
  combinedStale?: boolean;

  @Prop({ type: Object })
  combinedPdf?: ScannerStorageLocator;

  @Prop({ type: String, default: 'not-requested' })
  mergeStatus!: 'not-requested' | 'succeeded' | 'incompatible' | 'failed';

  @Prop({ trim: true })
  mergeReason?: string;

  @Prop({ type: Object })
  resultsZip?: ScannerStorageLocator;

  @Prop({ type: Object })
  previewPdf?: ScannerStorageLocator;

  @Prop({ type: Object })
  previewThumbnail?: ScannerStorageLocator;

  @Prop({ trim: true })
  providerRevision?: string;

  @Prop({ trim: true })
  modelRevision?: string;

  @Prop({ type: Object })
  engineProvenance?: ScannerEngineProvenance;

  /**
   * Design section 13.4 durations, kept on the job so the Phase 0 benchmark can
   * be answered from the collection rather than by scraping logs.
   */
  @Prop({ type: Object, default: {} })
  timings!: {
    queueWaitMs?: number;
    prepareMs?: number;
    providerMs?: number;
    renderMs?: number;
    totalMs?: number;
  };

  @Prop({ trim: true })
  errorCode?: string;

  @Prop({ trim: true })
  errorMessage?: string;

  @Prop({ type: Date })
  startedAt?: Date;

  @Prop({ type: Date })
  completedAt?: Date;

  @Prop({ type: Date, index: true })
  leaseExpiresAt?: Date;

  @Prop({ trim: true })
  leaseOwner?: string;

  @Prop({ type: Date })
  terminalNotifiedAt?: Date;

  @Prop({ type: Date })
  sourceDeletedAt?: Date;

  @Prop({ type: Date })
  resultsDeletedAt?: Date;

  @Prop({ type: Date, required: true, index: true })
  sourceExpiresAt!: Date;

  @Prop({ type: Date, required: true, index: true })
  resultExpiresAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export const ScannerJobSchema = SchemaFactory.createForClass(ScannerJob);

ScannerJobSchema.index({ userId: 1, createdAt: -1 });
ScannerJobSchema.index({ userId: 1, status: 1 });
ScannerJobSchema.index({ status: 1, leaseExpiresAt: 1, createdAt: 1 });
