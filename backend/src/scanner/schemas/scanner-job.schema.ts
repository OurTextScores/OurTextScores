import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

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
  pdf?: ScannerStorageLocator;
  providerRequestId?: string;
  /** Wall-clock time of the provider call that produced this result (13.4). */
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
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

  @Prop({ type: [Number] })
  retryPageNumbers?: number[];

  @Prop({ type: Date })
  preparedAt?: Date;

  /** Set when the job enters the provider queue; starts the queue-wait clock. */
  @Prop({ type: Date })
  queuedAt?: Date;

  @Prop({ type: Object })
  musicXmlBundle?: ScannerStorageLocator;

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
