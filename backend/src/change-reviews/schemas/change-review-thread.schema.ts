import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ collection: 'change_review_threads', timestamps: true })
export class ChangeReviewThread {
  @Prop({ required: true, unique: true, index: true, trim: true })
  threadId!: string;

  @Prop({ required: true, index: true, trim: true })
  reviewId!: string;

  @Prop({ required: true, index: true, trim: true })
  workId!: string;

  @Prop({ required: true, index: true, trim: true })
  sourceId!: string;

  @Prop({ required: true, enum: ['canonical'], default: 'canonical' })
  fileKind!: 'canonical';

  @Prop({
    type: {
      side: { type: String, trim: true, required: true },
      oldLineNumber: { type: Number },
      newLineNumber: { type: Number },
      anchorId: { type: String, trim: true, required: true },
      lineHash: { type: String, trim: true, required: true },
      lineText: { type: String, required: true },
      hunkHeader: { type: String, trim: true },
    },
    _id: false,
    required: true,
  })
  diffAnchor!: {
    side: 'base' | 'head';
    oldLineNumber?: number;
    newLineNumber?: number;
    anchorId: string;
    lineHash: string;
    lineText: string;
    hunkHeader?: string;
  };

  @Prop({ required: true, enum: ['open', 'resolved'], default: 'open', index: true })
  status!: 'open' | 'resolved';

  @Prop({ required: true, trim: true })
  createdByUserId!: string;

  @Prop({ type: Date })
  resolvedAt?: Date;

  @Prop({ trim: true })
  resolvedByUserId?: string;

  @Prop({ type: Date, required: true })
  createdAt!: Date;

  @Prop({ type: Date, required: true })
  updatedAt!: Date;
}

export type ChangeReviewThreadDocument = HydratedDocument<ChangeReviewThread>;
export const ChangeReviewThreadSchema = SchemaFactory.createForClass(ChangeReviewThread);

ChangeReviewThreadSchema.index({ reviewId: 1, createdAt: 1 });
ChangeReviewThreadSchema.index({ reviewId: 1, status: 1, updatedAt: -1 });
ChangeReviewThreadSchema.index({ reviewId: 1, 'diffAnchor.anchorId': 1 });
