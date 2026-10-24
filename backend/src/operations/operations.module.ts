import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { OperationsController } from './operations.controller';
import { UploadOperationsService } from './upload-operations.service';
import {
  UploadLimitAudit,
  UploadLimitAuditSchema,
  UploadOperation,
  UploadOperationSchema
} from './upload-operation.schema';

@Module({
  imports: [
    AuthModule,
    MongooseModule.forFeature([
      { name: UploadOperation.name, schema: UploadOperationSchema },
      { name: UploadLimitAudit.name, schema: UploadLimitAuditSchema }
    ])
  ],
  controllers: [OperationsController],
  providers: [UploadOperationsService],
  exports: [UploadOperationsService]
})
export class OperationsModule {}
