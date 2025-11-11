import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({
  collection: 'imslp',
  timestamps: true,
  strict: false
})
export class ImslpWork {
  @Prop({ required: true, unique: true, index: true, trim: true })
  workId!: string;

  @Prop({ trim: true })
  title?: string;

  @Prop({ trim: true })
  composer?: string;

  @Prop({ trim: true })
  permalink?: string;

  @Prop({ type: Object })
  metadata?: Record<string, unknown>;
}

export type ImslpWorkDocument = HydratedDocument<ImslpWork>;
export const ImslpWorkSchema = SchemaFactory.createForClass(ImslpWork);
