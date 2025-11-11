import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SourceBranch, SourceBranchSchema } from './schemas/source-branch.schema';
import { BranchesService } from './branches.service';
import { BranchesController } from './branches.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    AuthModule,
    MongooseModule.forFeature([{ name: SourceBranch.name, schema: SourceBranchSchema }])
  ],
  providers: [BranchesService],
  controllers: [BranchesController],
  exports: [BranchesService]
})
export class BranchesModule {}

