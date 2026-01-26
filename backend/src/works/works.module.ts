import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MongooseModule } from '@nestjs/mongoose';
import { WorksController } from './works.controller';
import { WorksService } from './works.service';
import { Work, WorkSchema } from './schemas/work.schema';
import { Source, SourceSchema } from './schemas/source.schema';
import { SourceRevision, SourceRevisionSchema } from './schemas/source-revision.schema';
import { RevisionRating, RevisionRatingSchema } from './schemas/revision-rating.schema';
import { UploadSourceService } from './upload-source.service';
import { StorageModule } from '../storage/storage.module';
import { DerivativePipelineService } from './derivative-pipeline.service';
import { FossilModule } from '../fossil/fossil.module';
import { ImslpModule } from '../imslp/imslp.module';
import { ProgressModule } from '../progress/progress.module';
import { BranchesModule } from '../branches/branches.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WatchesModule } from '../watches/watches.module';
import { SearchModule } from '../search/search.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    AuthModule,
    StorageModule,
    FossilModule,
    ProgressModule,
    ImslpModule,
    BranchesModule,
    NotificationsModule,
    WatchesModule,
    SearchModule,
    UsersModule,
    MongooseModule.forFeature([
      { name: Work.name, schema: WorkSchema },
      { name: Source.name, schema: SourceSchema },
      { name: SourceRevision.name, schema: SourceRevisionSchema },
      { name: RevisionRating.name, schema: RevisionRatingSchema }
    ])
  ],
  controllers: [WorksController],
  providers: [WorksService, UploadSourceService, DerivativePipelineService],
  exports: [WorksService, UploadSourceService]
})
export class WorksModule {}
