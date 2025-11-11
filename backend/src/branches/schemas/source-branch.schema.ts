import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type BranchPolicy = 'public' | 'owner_approval';

@Schema({ collection: 'source_branches', timestamps: true })
export class SourceBranch {
  @Prop({ required: true, index: true, trim: true })
  workId!: string;

  @Prop({ required: true, index: true, trim: true })
  sourceId!: string;

  @Prop({ required: true, trim: true })
  name!: string; // e.g. "main"

  @Prop({ required: true, enum: ['public', 'owner_approval'], default: 'public' })
  policy!: BranchPolicy;

  @Prop({ trim: true })
  ownerUserId?: string;

  @Prop({ trim: true })
  baseRevisionId?: string; // The revision this branch was created from
}

export type SourceBranchDocument = HydratedDocument<SourceBranch>;
export const SourceBranchSchema = SchemaFactory.createForClass(SourceBranch);
SourceBranchSchema.index({ workId: 1, sourceId: 1, name: 1 }, { unique: true });

