import { HydratedDocument } from 'mongoose';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({
  collection: 'enforcement_actions',
  timestamps: true
})
export class EnforcementAction {
  @Prop({ required: true, unique: true, index: true, trim: true })
  actionId!: string;

  @Prop({ required: true, index: true, trim: true })
  caseId!: string;

  @Prop({
    required: true,
    trim: true,
    enum: [
      'notice_received',
      'counter_notice_received',
      'case_status_changed',
      'content_withheld',
      'content_restored'
    ]
  })
  actionType!:
    | 'notice_received'
    | 'counter_notice_received'
    | 'case_status_changed'
    | 'content_withheld'
    | 'content_restored';

  @Prop({ trim: true })
  actorUserId?: string;

  @Prop({ trim: true })
  actorRole?: string;

  @Prop({ type: Object })
  metadata?: Record<string, unknown>;

  @Prop({ type: Date, required: true, default: () => new Date(), index: true })
  createdAt!: Date;
}

export type EnforcementActionDocument = HydratedDocument<EnforcementAction>;
export const EnforcementActionSchema = SchemaFactory.createForClass(EnforcementAction);
EnforcementActionSchema.index({ caseId: 1, createdAt: -1 });
