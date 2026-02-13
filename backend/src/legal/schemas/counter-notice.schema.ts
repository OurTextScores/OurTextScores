import { HydratedDocument } from 'mongoose';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({
  collection: 'counter_notices',
  timestamps: true
})
export class CounterNotice {
  @Prop({ required: true, unique: true, index: true, trim: true })
  counterNoticeId!: string;

  @Prop({ required: true, index: true, trim: true })
  caseId!: string;

  @Prop({ required: true, trim: true, index: true })
  submittedByUserId!: string;

  @Prop({ required: true, trim: true })
  fullName!: string;

  @Prop({ required: true, trim: true })
  address!: string;

  @Prop({ required: true, trim: true })
  phone!: string;

  @Prop({ required: true, trim: true })
  email!: string;

  @Prop({ required: true, trim: true })
  statement!: string;

  @Prop({ required: true, default: false })
  consentToJurisdiction!: boolean;

  @Prop({ required: true, trim: true })
  signature!: string;

  @Prop({ trim: true })
  requestIp?: string;

  @Prop({ trim: true })
  requestId?: string;

  @Prop({ type: Date, required: true, default: () => new Date(), index: true })
  submittedAt!: Date;
}

export type CounterNoticeDocument = HydratedDocument<CounterNotice>;
export const CounterNoticeSchema = SchemaFactory.createForClass(CounterNotice);
CounterNoticeSchema.index({ caseId: 1, submittedAt: -1 });
