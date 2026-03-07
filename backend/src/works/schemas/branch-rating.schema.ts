import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({
  collection: 'branch_ratings',
  timestamps: true
})
export class BranchRating {
  @Prop({ required: true, index: true, trim: true })
  workId!: string;

  @Prop({ required: true, index: true, trim: true })
  sourceId!: string;

  @Prop({ required: true, index: true, trim: true })
  branchName!: string;

  @Prop({ required: true, trim: true })
  userId!: string;

  @Prop({ required: true, min: 1, max: 5 })
  rating!: number;

  @Prop({ required: true, default: false })
  isAdmin!: boolean;

  @Prop({ type: Date, required: true })
  ratedAt!: Date;
}

export type BranchRatingDocument = HydratedDocument<BranchRating>;
export const BranchRatingSchema = SchemaFactory.createForClass(BranchRating);

BranchRatingSchema.index({ workId: 1, sourceId: 1, branchName: 1, userId: 1 }, { unique: true });
BranchRatingSchema.index({ workId: 1, sourceId: 1, branchName: 1, rating: 1, isAdmin: 1 });
