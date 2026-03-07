import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({
  collection: 'branch_comment_votes',
  timestamps: true
})
export class BranchCommentVote {
  @Prop({ required: true, index: true, trim: true })
  commentId!: string;

  @Prop({ required: true, trim: true })
  userId!: string;

  @Prop({ required: true, enum: ['up', 'down'] })
  voteType!: 'up' | 'down';

  @Prop({ type: Date, required: true })
  votedAt!: Date;
}

export type BranchCommentVoteDocument = HydratedDocument<BranchCommentVote>;
export const BranchCommentVoteSchema = SchemaFactory.createForClass(BranchCommentVote);

BranchCommentVoteSchema.index({ commentId: 1, userId: 1 }, { unique: true });
