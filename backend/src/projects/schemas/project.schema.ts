import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({
  collection: 'projects',
  timestamps: true
})
export class Project {
  @Prop({ required: true, unique: true, index: true, trim: true })
  projectId!: string;

  @Prop({ required: true, unique: true, index: true, trim: true, lowercase: true })
  slug!: string;

  @Prop({ required: true, trim: true })
  title!: string;

  @Prop({ default: '', trim: true })
  description!: string;

  @Prop({ required: true, index: true, trim: true })
  leadUserId!: string;

  @Prop({ type: [String], default: [] })
  memberUserIds!: string[];

  @Prop({ required: true, enum: ['public', 'private'], default: 'public' })
  visibility!: 'public' | 'private';

  @Prop({ required: true, enum: ['active', 'archived'], default: 'active' })
  status!: 'active' | 'archived';

  @Prop({ required: true, min: 0, default: 0 })
  rowCount!: number;

  @Prop({ required: true, min: 0, default: 0 })
  linkedSourceCount!: number;

  @Prop({ required: true, trim: true })
  createdBy!: string;

  @Prop({ trim: true, enum: ['google'] })
  spreadsheetProvider?: 'google';

  @Prop({ trim: true })
  spreadsheetEmbedUrl?: string;

  @Prop({ trim: true })
  spreadsheetExternalUrl?: string;
}

export type ProjectDocument = HydratedDocument<Project>;
export const ProjectSchema = SchemaFactory.createForClass(Project);

ProjectSchema.index({ leadUserId: 1, status: 1 });
ProjectSchema.index({ memberUserIds: 1, status: 1 });
ProjectSchema.index({ updatedAt: -1 });
