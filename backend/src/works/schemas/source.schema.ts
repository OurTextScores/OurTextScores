import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { StorageLocator, StorageLocatorSchema } from './storage-locator.schema';
import { ValidationState, ValidationStateSchema } from './validation.schema';
import { Provenance, ProvenanceSchema } from './provenance.schema';
import { DerivativeArtifacts, DerivativeArtifactsSchema } from './derivatives.schema';

@Schema({
  collection: 'sources',
  timestamps: true
})
export class Source {
  @Prop({ required: true, index: true, trim: true })
  workId!: string;

  @Prop({ required: true, unique: true, index: true, trim: true })
  sourceId!: string;

  @Prop({ required: true, trim: true })
  label!: string;

  @Prop({
    required: true,
    enum: ['score', 'parts', 'audio', 'metadata', 'other']
  })
  sourceType!: 'score' | 'parts' | 'audio' | 'metadata' | 'other';

  @Prop({ required: true, trim: true })
  format!: string;

  @Prop({ trim: true })
  description?: string;

  @Prop({
    trim: true,
    enum: [
      'CC0',
      'CC-BY-4.0',
      'CC-BY-SA-4.0',
      'CC-BY-NC-4.0',
      'CC-BY-NC-SA-4.0',
      'CC-BY-ND-4.0',
      'Public Domain',
      'All Rights Reserved',
      'Other'
    ]
  })
  license?: string;

  @Prop({ trim: true })
  licenseUrl?: string;

  @Prop({ trim: true })
  licenseAttribution?: string;

  @Prop({ required: true, trim: true })
  originalFilename!: string;

  @Prop({ required: true, default: false })
  isPrimary!: boolean;

  @Prop({ required: true, default: false })
  hasReferencePdf!: boolean;

  @Prop({ type: StorageLocatorSchema, required: true })
  storage!: StorageLocator;

  @Prop({ type: ValidationStateSchema, required: true })
  validation!: ValidationState;

  @Prop({ type: ProvenanceSchema, required: true })
  provenance!: Provenance;

  @Prop({ type: DerivativeArtifactsSchema })
  derivatives?: DerivativeArtifacts;

  @Prop({ trim: true })
  latestRevisionId?: string;

  @Prop({ type: Date })
  latestRevisionAt?: Date;

  // Admin verification (source is a valid transcription)
  @Prop({ default: false })
  adminVerified?: boolean;

  @Prop({ trim: true })
  adminVerifiedBy?: string;

  @Prop({ type: Date })
  adminVerifiedAt?: Date;

  @Prop({ trim: true })
  adminVerificationNote?: string;

  // Admin flagging (source should be deleted)
  @Prop({ default: false })
  adminFlagged?: boolean;

  @Prop({ trim: true })
  adminFlaggedBy?: string;

  @Prop({ type: Date })
  adminFlaggedAt?: Date;

  @Prop({ trim: true })
  adminFlagReason?: string;

  @Prop({ type: [String], default: [] })
  projectIds?: string[];

  @Prop({ required: true, min: 0, default: 0 })
  projectLinkCount?: number;
}

export type SourceDocument = HydratedDocument<Source>;
export const SourceSchema = SchemaFactory.createForClass(Source);
// Common query pattern: list sources by work and recent activity
SourceSchema.index({ workId: 1, latestRevisionAt: -1 });
// Lookup sources uploaded by a specific user
SourceSchema.index({ 'provenance.uploadedByUserId': 1, workId: 1 });
SourceSchema.index({ projectIds: 1 });
