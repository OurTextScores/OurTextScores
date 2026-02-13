import { HydratedDocument } from 'mongoose';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ _id: false })
class TakedownTarget {
  @Prop({ required: true, trim: true })
  workId!: string;

  @Prop({ required: true, trim: true })
  sourceId!: string;

  @Prop({ trim: true })
  revisionId?: string;

  @Prop({ required: true, trim: true, enum: ['source', 'revision'] })
  scope!: 'source' | 'revision';
}

@Schema({ _id: false })
class TakedownComplainant {
  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ required: true, trim: true, lowercase: true })
  email!: string;

  @Prop({ trim: true })
  organization?: string;

  @Prop({ trim: true })
  address?: string;

  @Prop({ trim: true })
  phone?: string;
}

@Schema({ _id: false })
class ContentActionState {
  @Prop({ required: true, trim: true, enum: ['none', 'withheld'], default: 'none' })
  state!: 'none' | 'withheld';

  @Prop({ type: Date })
  withheldAt?: Date;

  @Prop({ type: Date })
  restoredAt?: Date;

  @Prop({ trim: true })
  reason?: string;
}

const TakedownTargetSchema = SchemaFactory.createForClass(TakedownTarget);
const TakedownComplainantSchema = SchemaFactory.createForClass(TakedownComplainant);
const ContentActionStateSchema = SchemaFactory.createForClass(ContentActionState);

@Schema({
  collection: 'takedown_cases',
  timestamps: true
})
export class TakedownCase {
  @Prop({ required: true, unique: true, index: true, trim: true })
  caseId!: string;

  @Prop({ required: true, trim: true, enum: ['dmca'], default: 'dmca' })
  framework!: 'dmca';

  @Prop({
    required: true,
    trim: true,
    index: true,
    enum: [
      'notice_received',
      'pending_review',
      'content_disabled',
      'counter_notice_received',
      'restored',
      'rejected',
      'withdrawn'
    ],
    default: 'notice_received'
  })
  status!:
    | 'notice_received'
    | 'pending_review'
    | 'content_disabled'
    | 'counter_notice_received'
    | 'restored'
    | 'rejected'
    | 'withdrawn';

  @Prop({ type: TakedownTargetSchema, required: true })
  target!: TakedownTarget;

  @Prop({ type: TakedownComplainantSchema, required: true })
  complainant!: TakedownComplainant;

  @Prop({ trim: true, index: true })
  uploaderUserId?: string;

  @Prop({ trim: true, index: true })
  noticeId?: string;

  @Prop({ type: Date, required: true, default: () => new Date(), index: true })
  submittedAt!: Date;

  @Prop({ trim: true })
  reviewedByUserId?: string;

  @Prop({ type: Date })
  reviewedAt?: Date;

  @Prop({ trim: true })
  reviewNote?: string;

  @Prop({ type: ContentActionStateSchema, default: { state: 'none' } })
  contentAction?: ContentActionState;
}

export type TakedownCaseDocument = HydratedDocument<TakedownCase>;
export const TakedownCaseSchema = SchemaFactory.createForClass(TakedownCase);
TakedownCaseSchema.index({ 'target.workId': 1, 'target.sourceId': 1, 'target.revisionId': 1 });
