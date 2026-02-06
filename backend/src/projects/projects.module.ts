import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { ImslpModule } from '../imslp/imslp.module';
import { Project, ProjectSchema } from './schemas/project.schema';
import { ProjectSourceRow, ProjectSourceRowSchema } from './schemas/project-source-row.schema';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { Source, SourceSchema } from '../works/schemas/source.schema';
import { Work, WorkSchema } from '../works/schemas/work.schema';
import { User, UserSchema } from '../users/schemas/user.schema';

@Module({
  imports: [
    AuthModule,
    ImslpModule,
    MongooseModule.forFeature([
      { name: Project.name, schema: ProjectSchema },
      { name: ProjectSourceRow.name, schema: ProjectSourceRowSchema },
      { name: Source.name, schema: SourceSchema },
      { name: Work.name, schema: WorkSchema },
      { name: User.name, schema: UserSchema }
    ])
  ],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService]
})
export class ProjectsModule {}
