import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ChangeReviewStatus = 'draft' | 'open' | 'closed' | 'withdrawn';

@Schema({ collection: 'change_reviews', timestamps: true })
export class ChangeReview {
  @Prop({ required: true, unique: true, index: true, trim: true })
  reviewId!: string;

  @Prop({ required: true, index: true, trim: true })
  workId!: string;

  @Prop({ required: true, index: true, trim: true })
  sourceId!: string;

  @Prop({ trim: true })
  branchName?: string;

  @Prop({ required: true, trim: true })
  baseRevisionId!: string;

  @Prop({ required: true, trim: true })
  headRevisionId!: string;

  @Prop({ required: true, min: 0 })
  baseSequenceNumber!: number;

  @Prop({ required: true, min: 0 })
  headSequenceNumber!: number;

  @Prop({ required: true, index: true, trim: true })
  reviewerUserId!: string;

  @Prop({ required: true, index: true, trim: true })
  ownerUserId!: string;

  @Prop({ type: [String], default: [] })
  participantUserIds!: string[];

  @Prop({ trim: true })
  title?: string;

  @Prop({ trim: true })
  summary?: string;

  @Prop({ required: true, enum: ['draft', 'open', 'closed', 'withdrawn'], default: 'draft', index: true })
  status!: ChangeReviewStatus;

  @Prop({ required: true, min: 0, default: 0 })
  unresolvedThreadCount!: number;

  @Prop({ type: Date })
  submittedAt?: Date;

  @Prop({ type: Date })
  closedAt?: Date;

  @Prop({ trim: true })
  closedByUserId?: string;

  @Prop({ trim: true, enum: ['completed', 'withdrawn'] })
  closedReason?: 'completed' | 'withdrawn';

  @Prop({ type: Date, required: true })
  lastActivityAt!: Date;

  @Prop({ type: Date, required: true })
  createdAt!: Date;

  @Prop({ type: Date, required: true })
  updatedAt!: Date;
}

export type ChangeReviewDocument = HydratedDocument<ChangeReview>;
export const ChangeReviewSchema = SchemaFactory.createForClass(ChangeReview);

ChangeReviewSchema.index({ reviewerUserId: 1, status: 1, lastActivityAt: -1 });
ChangeReviewSchema.index({ ownerUserId: 1, status: 1, lastActivityAt: -1 });
ChangeReviewSchema.index({ workId: 1, sourceId: 1, headRevisionId: 1, status: 1 });
ChangeReviewSchema.index(
  {
    reviewerUserId: 1,
    workId: 1,
    sourceId: 1,
    baseRevisionId: 1,
    headRevisionId: 1,
    status: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ['draft', 'open'] },
    },
  },
);
