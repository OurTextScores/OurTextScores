import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({
  collection: 'revision_comment_votes',
  timestamps: true
})
export class RevisionCommentVote {
  @Prop({ required: true, index: true, trim: true })
  commentId!: string;

  @Prop({ required: true, trim: true })
  userId!: string;

  @Prop({ required: true, enum: ['up', 'down'] })
  voteType!: 'up' | 'down';

  @Prop({ type: Date, required: true })
  votedAt!: Date;
}

export type RevisionCommentVoteDocument = HydratedDocument<RevisionCommentVote>;
export const RevisionCommentVoteSchema = SchemaFactory.createForClass(RevisionCommentVote);

// One vote per user per comment
RevisionCommentVoteSchema.index({ commentId: 1, userId: 1 }, { unique: true });
