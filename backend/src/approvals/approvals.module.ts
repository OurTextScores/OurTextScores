import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ApprovalsController } from './approvals.controller';
import { SourceRevision, SourceRevisionSchema } from '../works/schemas/source-revision.schema';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    AuthModule,
    MongooseModule.forFeature([{ name: SourceRevision.name, schema: SourceRevisionSchema }])
  ],
  controllers: [ApprovalsController]
})
export class ApprovalsModule {}

