import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ImslpController } from './imslp.controller';
import { ImslpService } from './imslp.service';
import { ImslpWork, ImslpWorkSchema } from './schemas/imslp-work.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: ImslpWork.name, schema: ImslpWorkSchema }])],
  controllers: [ImslpController],
  providers: [ImslpService],
  exports: [ImslpService]
})
export class ImslpModule {}
