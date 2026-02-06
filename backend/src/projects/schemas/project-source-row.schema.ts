import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({
  collection: 'project_source_rows',
  timestamps: true
})
export class ProjectSourceRow {
  @Prop({ required: true, index: true, trim: true })
  projectId!: string;

  @Prop({ required: true, trim: true })
  rowId!: string;

  @Prop({ trim: true })
  externalScoreUrl?: string;

  @Prop({ trim: true })
  imslpUrl?: string;

  @Prop({ trim: true })
  linkedWorkId?: string;

  @Prop({ trim: true })
  linkedSourceId?: string;

  @Prop({ trim: true })
  linkedRevisionId?: string;

  @Prop({ required: true, default: false })
  hasReferencePdf!: boolean;

  @Prop({ required: true, default: false })
  verified!: boolean;

  @Prop({ type: Date })
  verifiedAt?: Date;

  @Prop({ trim: true })
  verifiedBy?: string;

  @Prop({ trim: true })
  notes?: string;

  @Prop({ required: true, trim: true })
  createdBy!: string;

  @Prop({ required: true, trim: true })
  updatedBy!: string;

  @Prop({ required: true, min: 1, default: 1 })
  rowVersion!: number;
}

export type ProjectSourceRowDocument = HydratedDocument<ProjectSourceRow>;
export const ProjectSourceRowSchema = SchemaFactory.createForClass(ProjectSourceRow);

ProjectSourceRowSchema.index({ projectId: 1, rowId: 1 }, { unique: true });
ProjectSourceRowSchema.index({ projectId: 1, updatedAt: -1 });
ProjectSourceRowSchema.index({ linkedSourceId: 1 });
ProjectSourceRowSchema.index({ imslpUrl: 1 }, { sparse: true });
