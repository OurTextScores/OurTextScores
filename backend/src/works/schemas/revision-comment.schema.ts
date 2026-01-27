import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({
  collection: 'revision_comments',
  timestamps: true
})
export class RevisionComment {
  @Prop({ required: true, unique: true, index: true, trim: true })
  commentId!: string;

  @Prop({ required: true, index: true, trim: true })
  workId!: string;

  @Prop({ required: true, index: true, trim: true })
  sourceId!: string;

  @Prop({ required: true, index: true, trim: true })
  revisionId!: string;

  @Prop({ required: true, trim: true })
  userId!: string;

  @Prop({ required: true })
  content!: string;

  // For threading - null if top-level comment
  @Prop({ trim: true, index: true })
  parentCommentId?: string;

  @Prop({ required: true, default: 0 })
  voteScore!: number; // upvotes - downvotes

  @Prop({ type: Date, required: true })
  createdAt!: Date;

  @Prop({ type: Date })
  editedAt?: Date;

  // Flagging
  @Prop({ default: false })
  flagged?: boolean;

  @Prop({ trim: true })
  flaggedBy?: string;

  @Prop({ type: Date })
  flaggedAt?: Date;

  @Prop({ trim: true })
  flagReason?: string;

  // Soft delete
  @Prop({ default: false })
  deleted?: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export type RevisionCommentDocument = HydratedDocument<RevisionComment>;
export const RevisionCommentSchema = SchemaFactory.createForClass(RevisionComment);

// Index for efficient queries
RevisionCommentSchema.index({ revisionId: 1, parentCommentId: 1, voteScore: -1, createdAt: -1 });
RevisionCommentSchema.index({ userId: 1, createdAt: -1 });
