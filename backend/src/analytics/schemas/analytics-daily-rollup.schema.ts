import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes } from 'mongoose';

@Schema({
  collection: 'analytics_daily_rollups',
  timestamps: true
})
export class AnalyticsDailyRollup {
  @Prop({ required: true, index: true })
  timezone!: string;

  @Prop({ required: true, index: true })
  dateKey!: string;

  @Prop({ required: true, index: true })
  includeInBusinessMetrics!: boolean;

  @Prop({ required: true })
  bucketStart!: Date;

  @Prop({ type: Number, default: 0 })
  wae!: number;

  @Prop({ type: Number, default: 0 })
  wacu!: number;

  @Prop({ type: Number, default: 0 })
  weu!: number;

  @Prop({ type: Number, default: 0 })
  newSignups!: number;

  @Prop({ type: Number, default: 0 })
  uploadsSuccess!: number;

  @Prop({ type: Number, default: 0 })
  revisionsSaved!: number;

  @Prop({ type: Number, default: 0 })
  searches!: number;

  @Prop({ type: Number, default: 0 })
  views!: number;

  @Prop({ type: Number, default: 0 })
  comments!: number;

  @Prop({ type: Number, default: 0 })
  ratings!: number;

  @Prop({ type: Number, default: 0 })
  downloads!: number;

  @Prop({ type: SchemaTypes.Mixed, default: {} })
  downloadsByFormat!: Record<string, number>;

  @Prop({ required: true, default: () => new Date() })
  computedAt!: Date;
}

export type AnalyticsDailyRollupDocument = HydratedDocument<AnalyticsDailyRollup>;
export const AnalyticsDailyRollupSchema = SchemaFactory.createForClass(AnalyticsDailyRollup);

AnalyticsDailyRollupSchema.index(
  { timezone: 1, dateKey: 1, includeInBusinessMetrics: 1 },
  { unique: true }
);
AnalyticsDailyRollupSchema.index({ bucketStart: 1, timezone: 1, includeInBusinessMetrics: 1 });
