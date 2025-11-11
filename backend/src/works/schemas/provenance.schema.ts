import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ _id: false })
export class Provenance {
  @Prop({ required: true, enum: ['manual', 'batch', 'sync'] })
  ingestType!: 'manual' | 'batch' | 'sync';

  @Prop({ trim: true })
  sourceSystem?: string;

  @Prop({ trim: true })
  sourceIdentifier?: string;

  @Prop({ trim: true })
  uploadedByUserId?: string;

  @Prop({ trim: true })
  uploadedByName?: string;

  @Prop({ type: Date, required: true })
  uploadedAt!: Date;

  @Prop({ type: [String], default: [] })
  notes!: string[];
}

export const ProvenanceSchema = SchemaFactory.createForClass(Provenance);
