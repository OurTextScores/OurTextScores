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

export interface ScannerPageResult {
  pageNumber: number;
  ordinal: number;
  rotationDegrees: 0 | 90 | 180 | 270;
  included: boolean;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';
  attempts: number;
  idempotencyKey: string;
  manualRetries?: number;
  sourceImage?: ScannerStorageLocator;
  thumbnail?: ScannerStorageLocator;
  musicXml?: ScannerStorageLocator;
  pdf?: ScannerStorageLocator;
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

  @Prop({ required: true, trim: true })
  originalFilename!: string;

  @Prop({ required: true, trim: true })
  inputContentType!: string;

  @Prop({ required: true, min: 1 })
  pageCount!: number;

  @Prop({ required: true, type: Object })
  input!: ScannerStorageLocator;

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
