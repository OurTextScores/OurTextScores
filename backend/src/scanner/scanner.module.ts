import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WorksModule } from '../works/works.module';
import { ScannerJob, ScannerJobSchema } from './schemas/scanner-job.schema';
import { ScannerCorrection, ScannerCorrectionSchema } from './schemas/scanner-correction.schema';
import { ScannerController } from './scanner.controller';
import { ScannerProviderService } from './scanner-provider.service';
import { ScannerService } from './scanner.service';
import { ScannerAlertService } from './scanner-alert.service';
import { ScannerMergeService } from './scanner-merge.service';
import { ScannerTelemetryService } from './scanner-telemetry.service';
import { ScannerWorkerService } from './scanner-worker.service';
import { ScannerProviderHttpService } from './scanner-provider-http.service';
import { ScannerTranscodaProviderService } from './scanner-transcoda-provider.service';

@Module({
  imports: [
    AnalyticsModule,
    AuthModule,
    StorageModule,
    NotificationsModule,
    WorksModule,
    MongooseModule.forFeature([
      { name: ScannerJob.name, schema: ScannerJobSchema },
      { name: ScannerCorrection.name, schema: ScannerCorrectionSchema }
    ])
  ],
  controllers: [ScannerController],
  providers: [
    ScannerService,
    ScannerAlertService,
    ScannerMergeService,
    ScannerProviderHttpService,
    ScannerProviderService,
    ScannerTranscodaProviderService,
    ScannerTelemetryService,
    ScannerWorkerService
  ],
  exports: [ScannerService]
})
export class ScannerModule {}
