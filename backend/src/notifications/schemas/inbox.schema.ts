import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type NotificationInboxDocument = NotificationInbox & Document;

@Schema({
  collection: 'notification_inbox',
  timestamps: true
})
export class NotificationInbox {
  @Prop({ required: true, unique: true, index: true, trim: true })
  notificationId!: string; // UUID

  @Prop({ required: true, index: true, trim: true })
  userId!: string; // recipient user ID

  @Prop({ required: true, enum: ['comment_reply', 'source_comment', 'new_revision'] })
  type!: 'comment_reply' | 'source_comment' | 'new_revision';

  @Prop({ required: true, trim: true })
  workId!: string;

  @Prop({ required: true, trim: true })
  sourceId!: string;

  @Prop({ required: true, trim: true })
  revisionId!: string;

  @Prop({ type: Object, default: {} })
  payload!: Record<string, any>; // type-specific data (commentId, actorUserId, etc.)

  @Prop({ required: true, default: false })
  read!: boolean;

  @Prop({ default: false })
  emailSent?: boolean; // Track if email notification was sent

  @Prop({ type: Date })
  emailSentAt?: Date; // When email was sent

  @Prop({ type: Date, required: true })
  createdAt!: Date;
}

export const NotificationInboxSchema = SchemaFactory.createForClass(NotificationInbox);

// Indexes for efficient queries
NotificationInboxSchema.index({ userId: 1, createdAt: -1 });
NotificationInboxSchema.index({ userId: 1, read: 1, createdAt: -1 });
