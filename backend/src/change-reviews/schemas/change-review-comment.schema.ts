import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ collection: 'change_review_comments', timestamps: true })
export class ChangeReviewComment {
  @Prop({ required: true, unique: true, index: true, trim: true })
  commentId!: string;

  @Prop({ required: true, index: true, trim: true })
  reviewId!: string;

  @Prop({ required: true, index: true, trim: true })
  threadId!: string;

  @Prop({ required: true, trim: true })
  userId!: string;

  @Prop({ required: true })
  content!: string;

  @Prop({ type: Date, required: true })
  createdAt!: Date;

  @Prop({ type: Date })
  editedAt?: Date;

  @Prop({ default: false })
  deleted?: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export type ChangeReviewCommentDocument = HydratedDocument<ChangeReviewComment>;
export const ChangeReviewCommentSchema = SchemaFactory.createForClass(ChangeReviewComment);

ChangeReviewCommentSchema.index({ threadId: 1, createdAt: 1 });
ChangeReviewCommentSchema.index({ reviewId: 1, createdAt: 1 });
