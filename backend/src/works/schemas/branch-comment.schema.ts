import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({
  collection: 'branch_comments',
  timestamps: true
})
export class BranchComment {
  @Prop({ required: true, unique: true, index: true, trim: true })
  commentId!: string;

  @Prop({ required: true, index: true, trim: true })
  workId!: string;

  @Prop({ required: true, index: true, trim: true })
  sourceId!: string;

  @Prop({ required: true, index: true, trim: true })
  branchName!: string;

  @Prop({ required: true, trim: true })
  userId!: string;

  @Prop({ required: true })
  content!: string;

  @Prop({ trim: true, index: true })
  parentCommentId?: string;

  @Prop({ required: true, default: 0 })
  voteScore!: number;

  @Prop({ type: Date, required: true })
  createdAt!: Date;

  @Prop({ type: Date })
  editedAt?: Date;

  @Prop({ default: false })
  flagged?: boolean;

  @Prop({ trim: true })
  flaggedBy?: string;

  @Prop({ type: Date })
  flaggedAt?: Date;

  @Prop({ trim: true })
  flagReason?: string;

  @Prop({ default: false })
  deleted?: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export type BranchCommentDocument = HydratedDocument<BranchComment>;
export const BranchCommentSchema = SchemaFactory.createForClass(BranchComment);

BranchCommentSchema.index({ workId: 1, sourceId: 1, branchName: 1, parentCommentId: 1, voteScore: -1, createdAt: -1 });
BranchCommentSchema.index({ userId: 1, createdAt: -1 });
