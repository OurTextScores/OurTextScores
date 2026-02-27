import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes } from 'mongoose';
import { AnalyticsEventName, AnalyticsSourceApp } from '../analytics.constants';

@Schema({
  collection: 'analytics_events',
  timestamps: true
})
export class AnalyticsEvent {
  @Prop({ required: true, index: true })
  eventName!: AnalyticsEventName;

  @Prop({ required: true, index: true })
  eventTime!: Date;

  @Prop({ type: String, enum: ['frontend', 'backend', 'score_editor_api'], required: true, index: true })
  sourceApp!: AnalyticsSourceApp;

  @Prop({ type: String, default: null, index: true })
  userId!: string | null;

  @Prop({ type: String, enum: ['anonymous', 'user', 'admin'], required: true, index: true })
  userRole!: 'anonymous' | 'user' | 'admin';

  @Prop({ type: String, default: null })
  sessionId!: string | null;

  @Prop({ type: String, default: null, index: true })
  requestId!: string | null;

  @Prop({ type: String, default: null, index: true })
  traceId!: string | null;

  @Prop({ type: String, default: null })
  route!: string | null;

  @Prop({ type: SchemaTypes.Mixed, default: {} })
  properties!: Record<string, unknown>;

  @Prop({ type: Boolean, default: true, index: true })
  includeInBusinessMetrics!: boolean;
}

export type AnalyticsEventDocument = HydratedDocument<AnalyticsEvent>;
export const AnalyticsEventSchema = SchemaFactory.createForClass(AnalyticsEvent);

AnalyticsEventSchema.index({ eventTime: -1 });
AnalyticsEventSchema.index({ eventName: 1, eventTime: -1 });
AnalyticsEventSchema.index({ userId: 1, eventTime: -1 });
AnalyticsEventSchema.index({ includeInBusinessMetrics: 1, eventTime: -1 });
AnalyticsEventSchema.index(
  { eventName: 1, userId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      eventName: 'first_score_loaded',
      userId: { $exists: true, $ne: null }
    }
  }
);
