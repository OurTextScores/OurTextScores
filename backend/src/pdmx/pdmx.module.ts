import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { ProjectsModule } from '../projects/projects.module';
import { WorksModule } from '../works/works.module';
import { PdmxController } from './pdmx.controller';
import { PdmxService } from './pdmx.service';
import { PdmxRecord, PdmxRecordSchema } from './schemas/pdmx-record.schema';

@Module({
  imports: [
    AuthModule,
    ProjectsModule,
    WorksModule,
    MongooseModule.forFeature([{ name: PdmxRecord.name, schema: PdmxRecordSchema }])
  ],
  controllers: [PdmxController],
  providers: [PdmxService],
  exports: [PdmxService]
})
export class PdmxModule {}
