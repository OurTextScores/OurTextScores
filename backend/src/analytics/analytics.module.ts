import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { AnalyticsEvent, AnalyticsEventSchema } from './schemas/analytics-event.schema';
import { AnalyticsDailyRollup, AnalyticsDailyRollupSchema } from './schemas/analytics-daily-rollup.schema';
import { Work, WorkSchema } from '../works/schemas/work.schema';
import { Source, SourceSchema } from '../works/schemas/source.schema';
import { SourceRevision, SourceRevisionSchema } from '../works/schemas/source-revision.schema';

@Module({
  imports: [
    AuthModule,
    MongooseModule.forFeature([
      { name: AnalyticsEvent.name, schema: AnalyticsEventSchema },
      { name: AnalyticsDailyRollup.name, schema: AnalyticsDailyRollupSchema },
      { name: Work.name, schema: WorkSchema },
      { name: Source.name, schema: SourceSchema },
      { name: SourceRevision.name, schema: SourceRevisionSchema }
    ])
  ],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService]
})
export class AnalyticsModule {}
