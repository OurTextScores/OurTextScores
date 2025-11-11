import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ collection: 'watch_subscriptions', timestamps: true })
export class WatchSubscription {
  @Prop({ required: true, trim: true, index: true })
  userId!: string;

  @Prop({ required: true, trim: true, index: true })
  workId!: string;

  @Prop({ required: true, trim: true, index: true })
  sourceId!: string;
}

export type WatchSubscriptionDocument = HydratedDocument<WatchSubscription>;
export const WatchSubscriptionSchema = SchemaFactory.createForClass(WatchSubscription);
WatchSubscriptionSchema.index({ userId: 1, workId: 1, sourceId: 1 }, { unique: true });

