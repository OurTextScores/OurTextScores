import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import { Work, WorkSchema } from '../works/schemas/work.schema';
import { Source, SourceSchema } from '../works/schemas/source.schema';
import { SourceRevision, SourceRevisionSchema } from '../works/schemas/source-revision.schema';
import { SourceBranch, SourceBranchSchema } from '../branches/schemas/source-branch.schema';
import { ChangeReviewsController } from './change-reviews.controller';
import { ChangeReviewsService } from './change-reviews.service';
import { ChangeReview, ChangeReviewSchema } from './schemas/change-review.schema';
import { ChangeReviewThread, ChangeReviewThreadSchema } from './schemas/change-review-thread.schema';
import { ChangeReviewComment, ChangeReviewCommentSchema } from './schemas/change-review-comment.schema';

@Module({
  imports: [
    AuthModule,
    NotificationsModule,
    StorageModule,
    UsersModule,
    MongooseModule.forFeature([
      { name: ChangeReview.name, schema: ChangeReviewSchema },
      { name: ChangeReviewThread.name, schema: ChangeReviewThreadSchema },
      { name: ChangeReviewComment.name, schema: ChangeReviewCommentSchema },
      { name: Work.name, schema: WorkSchema },
      { name: Source.name, schema: SourceSchema },
      { name: SourceRevision.name, schema: SourceRevisionSchema },
      { name: SourceBranch.name, schema: SourceBranchSchema },
    ]),
  ],
  controllers: [ChangeReviewsController],
  providers: [ChangeReviewsService],
  exports: [ChangeReviewsService],
})
export class ChangeReviewsModule {}
