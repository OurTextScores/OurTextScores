import { HydratedDocument } from 'mongoose';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({
  collection: 'takedown_notices',
  timestamps: true
})
export class TakedownNotice {
  @Prop({ required: true, unique: true, index: true, trim: true })
  noticeId!: string;

  @Prop({ required: true, index: true, trim: true })
  caseId!: string;

  @Prop({ required: true, trim: true })
  complainantName!: string;

  @Prop({ required: true, trim: true, lowercase: true })
  complainantEmail!: string;

  @Prop({ trim: true })
  organization?: string;

  @Prop({ trim: true })
  address?: string;

  @Prop({ trim: true })
  phone?: string;

  @Prop({ required: true, trim: true })
  claimedWork!: string;

  @Prop({ required: true, trim: true })
  infringementStatement!: string;

  @Prop({ required: true, default: false })
  goodFaithStatement!: boolean;

  @Prop({ required: true, default: false })
  perjuryStatement!: boolean;

  @Prop({ required: true, trim: true })
  signature!: string;

  @Prop({ trim: true })
  requestIp?: string;

  @Prop({ trim: true })
  requestId?: string;

  @Prop({ type: Date, required: true, default: () => new Date(), index: true })
  submittedAt!: Date;
}

export type TakedownNoticeDocument = HydratedDocument<TakedownNotice>;
export const TakedownNoticeSchema = SchemaFactory.createForClass(TakedownNotice);
TakedownNoticeSchema.index({ caseId: 1, submittedAt: -1 });
