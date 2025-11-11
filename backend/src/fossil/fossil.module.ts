import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FossilService } from './fossil.service';

@Module({
  imports: [ConfigModule],
  providers: [FossilService],
  exports: [FossilService]
})
export class FossilModule {}
