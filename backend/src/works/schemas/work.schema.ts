import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({
  collection: 'works',
  timestamps: true
})
export class Work {
  @Prop({ required: true, unique: true, index: true, trim: true })
  workId!: string;

  @Prop({ type: Date })
  latestRevisionAt?: Date;

  @Prop({ required: true, min: 0, default: 0 })
  sourceCount!: number;

  @Prop({ type: [String], default: [] })
  availableFormats!: string[];

  @Prop({ required: true, default: false })
  hasReferencePdf!: boolean;

  @Prop({ required: true, default: false })
  hasVerifiedSources!: boolean;

  @Prop({ required: true, default: false })
  hasFlaggedSources!: boolean;

  // Optional human-friendly overrides
  @Prop({ trim: true })
  title?: string;

  @Prop({ trim: true })
  composer?: string;

  // Catalog number (e.g., Op. 35, BWV 1007, K. 545)
  @Prop({ trim: true })
  catalogNumber?: string;
}

export type WorkDocument = HydratedDocument<Work>;
export const WorkSchema = SchemaFactory.createForClass(Work);
// Helpful for listing/sorting works
WorkSchema.index({ latestRevisionAt: -1, workId: 1 });
