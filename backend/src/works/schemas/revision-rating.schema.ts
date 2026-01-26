import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({
  collection: 'revision_ratings',
  timestamps: true
})
export class RevisionRating {
  @Prop({ required: true, index: true, trim: true })
  workId!: string;

  @Prop({ required: true, index: true, trim: true })
  sourceId!: string;

  @Prop({ required: true, index: true, trim: true })
  revisionId!: string;

  @Prop({ required: true, trim: true })
  userId!: string;

  @Prop({ required: true, min: 1, max: 5 })
  rating!: number; // 1-5 stars

  @Prop({ required: true, default: false })
  isAdmin!: boolean;

  @Prop({ type: Date, required: true })
  ratedAt!: Date;
}

export type RevisionRatingDocument = HydratedDocument<RevisionRating>;
export const RevisionRatingSchema = SchemaFactory.createForClass(RevisionRating);

// Prevent duplicate ratings: one rating per user per revision
RevisionRatingSchema.index({ revisionId: 1, userId: 1 }, { unique: true });
// Efficient queries for histogram data
RevisionRatingSchema.index({ revisionId: 1, rating: 1, isAdmin: 1 });
