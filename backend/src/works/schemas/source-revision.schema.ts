import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { StorageLocator, StorageLocatorSchema } from './storage-locator.schema';
import { Checksum, ChecksumSchema } from './checksum.schema';
import { ValidationState, ValidationStateSchema } from './validation.schema';
import { DerivativeArtifacts, DerivativeArtifactsSchema } from './derivatives.schema';

@Schema({
  collection: 'source_revisions',
  timestamps: true
})
export class SourceRevision {
  @Prop({ required: true, index: true, trim: true })
  workId!: string;

  @Prop({ required: true, index: true, trim: true })
  sourceId!: string;

  @Prop({ required: true, unique: true, index: true, trim: true })
  revisionId!: string;

  @Prop({ required: true, min: 0 })
  sequenceNumber!: number;

  @Prop({ trim: true })
  fossilArtifactId?: string;

  @Prop({ type: [String], default: [] })
  fossilParentArtifactIds!: string[];

  @Prop({ trim: true })
  fossilBranch?: string;

  // Logical branch name (policy branch). Defaults to fossilBranch if present
  @Prop({ trim: true })
  branchName?: string;

  @Prop({ type: StorageLocatorSchema, required: true })
  rawStorage!: StorageLocator;

  @Prop({ type: ChecksumSchema, required: true })
  checksum!: Checksum;

  @Prop({ required: true, trim: true })
  createdBy!: string; // userId or 'system'

  @Prop({ type: Date, required: true })
  createdAt!: Date;

  @Prop({ type: ValidationStateSchema, required: true })
  validationSnapshot!: ValidationState;

  @Prop({ type: DerivativeArtifactsSchema })
  derivatives?: DerivativeArtifacts;

  @Prop({ type: StorageLocatorSchema })
  manifest?: StorageLocator;

  @Prop({ trim: true })
  changeSummary?: string;

  // Review/approval lifecycle
  @Prop({ trim: true, default: 'approved', index: true })
  status!: 'approved' | 'pending_approval' | 'rejected' | 'withdrawn';

  @Prop({
    type: {
      ownerUserId: { type: String, trim: true },
      requestedAt: { type: Date },
      decidedAt: { type: Date },
      decidedByUserId: { type: String, trim: true },
      decision: { type: String, trim: true },
      note: { type: String, trim: true }
    },
    _id: false
  })
  approval?: {
    ownerUserId?: string;
    requestedAt?: Date;
    decidedAt?: Date;
    decidedByUserId?: string;
    decision?: 'approved' | 'rejected';
    note?: string;
  };
}

export type SourceRevisionDocument = HydratedDocument<SourceRevision>;
export const SourceRevisionSchema = SchemaFactory.createForClass(SourceRevision);
// Efficient history queries per source
SourceRevisionSchema.index({ workId: 1, sourceId: 1, sequenceNumber: -1 });
SourceRevisionSchema.index({ workId: 1, sourceId: 1, status: 1, createdAt: -1 });
SourceRevisionSchema.index({ 'approval.ownerUserId': 1, status: 1, createdAt: -1 });
