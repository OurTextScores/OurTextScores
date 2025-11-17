import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from './schemas/user.schema';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { UsersPublicController } from './users-public.controller';
import { Source, SourceSchema } from '../works/schemas/source.schema';
import { SourceRevision, SourceRevisionSchema } from '../works/schemas/source-revision.schema';
import { Work, WorkSchema } from '../works/schemas/work.schema';

@Module({
  imports: [
    forwardRef(() => AuthModule),
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Source.name, schema: SourceSchema },
      { name: SourceRevision.name, schema: SourceRevisionSchema },
      { name: Work.name, schema: WorkSchema }
    ])
  ],
  providers: [UsersService],
  controllers: [UsersController, UsersPublicController],
  exports: [UsersService]
})
export class UsersModule {}
