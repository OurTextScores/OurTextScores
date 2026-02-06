import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { ImslpModule } from '../imslp/imslp.module';
import { Project, ProjectSchema } from './schemas/project.schema';
import { ProjectSourceRow, ProjectSourceRowSchema } from './schemas/project-source-row.schema';
import { ProjectsController } from './projects.controller';
import { ProjectsService, UPLOAD_SOURCE_SERVICE } from './projects.service';
import { Source, SourceSchema } from '../works/schemas/source.schema';
import { Work, WorkSchema } from '../works/schemas/work.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { WorksModule } from '../works/works.module';
import { UploadSourceService } from '../works/upload-source.service';

@Module({
  imports: [
    AuthModule,
    ImslpModule,
    WorksModule,
    MongooseModule.forFeature([
      { name: Project.name, schema: ProjectSchema },
      { name: ProjectSourceRow.name, schema: ProjectSourceRowSchema },
      { name: Source.name, schema: SourceSchema },
      { name: Work.name, schema: WorkSchema },
      { name: User.name, schema: UserSchema }
    ])
  ],
  controllers: [ProjectsController],
  providers: [
    ProjectsService,
    { provide: UPLOAD_SOURCE_SERVICE, useExisting: UploadSourceService }
  ],
  exports: [ProjectsService]
})
export class ProjectsModule {}
