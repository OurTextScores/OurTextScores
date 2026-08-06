import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WorksModule } from '../works/works.module';
import { ScannerJob, ScannerJobSchema } from './schemas/scanner-job.schema';
import { ScannerController } from './scanner.controller';
import { ScannerProviderService } from './scanner-provider.service';
import { ScannerService } from './scanner.service';
import { ScannerWorkerService } from './scanner-worker.service';

@Module({
  imports: [
    AuthModule,
    StorageModule,
    NotificationsModule,
    WorksModule,
    MongooseModule.forFeature([{ name: ScannerJob.name, schema: ScannerJobSchema }])
  ],
  controllers: [ScannerController],
  providers: [ScannerService, ScannerProviderService, ScannerWorkerService],
  exports: [ScannerService]
})
export class ScannerModule {}
