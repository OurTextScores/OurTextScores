import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type NotificationType = 'push_request' | 'new_revision' | 'digest_item';

@Schema({ collection: 'notification_outbox', timestamps: true })
export class NotificationOutbox {
  @Prop({ required: true, trim: true })
  type!: NotificationType;

  @Prop({ required: true, trim: true })
  workId!: string;

  @Prop({ required: true, trim: true })
  sourceId!: string;

  @Prop({ required: true, trim: true })
  revisionId!: string;

  @Prop({ type: [String], default: [] })
  recipients!: string[]; // userIds or emails; resolver decides

  @Prop({ type: Object, default: {} })
  payload!: Record<string, unknown>;

  @Prop({ trim: true, default: 'queued', index: true })
  status!: 'queued' | 'sent' | 'error';

  @Prop({ type: Number, default: 0 })
  attempts!: number;

  @Prop({ trim: true })
  lastError?: string;

  @Prop({ type: Date })
  sentAt?: Date;
}

export type NotificationOutboxDocument = HydratedDocument<NotificationOutbox>;
export const NotificationOutboxSchema = SchemaFactory.createForClass(NotificationOutbox);
NotificationOutboxSchema.index({ status: 1, createdAt: 1 });
