import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MongooseModule } from '@nestjs/mongoose';
import { WorksController } from './works.controller';
import { WorksDownloadsController } from './works-downloads.controller';
import { WorksEngagementController } from './works-engagement.controller';
import { WorksModerationController } from './works-moderation.controller';
import { WorksService } from './works.service';
import { Work, WorkSchema } from './schemas/work.schema';
import { Source, SourceSchema } from './schemas/source.schema';
import { SourceRevision, SourceRevisionSchema } from './schemas/source-revision.schema';
import { RevisionRating, RevisionRatingSchema } from './schemas/revision-rating.schema';
import { RevisionComment, RevisionCommentSchema } from './schemas/revision-comment.schema';
import { RevisionCommentVote, RevisionCommentVoteSchema } from './schemas/revision-comment-vote.schema';
import { BranchRating, BranchRatingSchema } from './schemas/branch-rating.schema';
import { BranchComment, BranchCommentSchema } from './schemas/branch-comment.schema';
import { BranchCommentVote, BranchCommentVoteSchema } from './schemas/branch-comment-vote.schema';
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
import { Project, ProjectSchema } from '../projects/schemas/project.schema';
import { AnalyticsModule } from '../analytics/analytics.module';
import { ChangeReviewsModule } from '../change-reviews/change-reviews.module';

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
    AnalyticsModule,
    ChangeReviewsModule,
    MongooseModule.forFeature([
      { name: Work.name, schema: WorkSchema },
      { name: Source.name, schema: SourceSchema },
      { name: SourceRevision.name, schema: SourceRevisionSchema },
      { name: RevisionRating.name, schema: RevisionRatingSchema },
      { name: RevisionComment.name, schema: RevisionCommentSchema },
      { name: RevisionCommentVote.name, schema: RevisionCommentVoteSchema },
      { name: BranchRating.name, schema: BranchRatingSchema },
      { name: BranchComment.name, schema: BranchCommentSchema },
      { name: BranchCommentVote.name, schema: BranchCommentVoteSchema },
      { name: Project.name, schema: ProjectSchema }
    ])
  ],
  controllers: [
    WorksController,
    WorksDownloadsController,
    WorksEngagementController,
    WorksModerationController,
  ],
  providers: [WorksService, UploadSourceService, DerivativePipelineService],
  exports: [WorksService, UploadSourceService]
})
export class WorksModule {}
