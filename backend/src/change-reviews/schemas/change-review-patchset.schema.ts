import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ collection: 'change_review_patchsets', timestamps: true })
export class ChangeReviewPatchset {
  @Prop({ required: true, index: true, trim: true })
  reviewId!: string;

  @Prop({ required: true, min: 1 })
  patchsetNumber!: number;

  @Prop({ required: true, index: true, trim: true })
  workId!: string;

  @Prop({ required: true, index: true, trim: true })
  sourceId!: string;

  @Prop({ required: true, trim: true })
  branchName!: string;

  @Prop({ required: true, trim: true })
  baseRevisionId!: string;

  @Prop({ required: true, trim: true })
  headRevisionId!: string;

  @Prop({ required: true, min: 0 })
  baseSequenceNumber!: number;

  @Prop({ required: true, min: 0 })
  headSequenceNumber!: number;

  @Prop({ trim: true })
  createdByUserId?: string;

  @Prop({ type: Date, required: true })
  createdAt!: Date;

  @Prop({ type: Date, required: true })
  updatedAt!: Date;
}

export type ChangeReviewPatchsetDocument = HydratedDocument<ChangeReviewPatchset>;
export const ChangeReviewPatchsetSchema = SchemaFactory.createForClass(ChangeReviewPatchset);

ChangeReviewPatchsetSchema.index({ reviewId: 1, patchsetNumber: 1 }, { unique: true });
ChangeReviewPatchsetSchema.index({ reviewId: 1, headRevisionId: 1 }, { unique: true });
