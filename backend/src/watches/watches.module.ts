import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { WatchSubscription, WatchSubscriptionSchema } from './schemas/watch.schema';
import { WatchesService } from './watches.service';
import { WatchesController } from './watches.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    AuthModule,
    MongooseModule.forFeature([{ name: WatchSubscription.name, schema: WatchSubscriptionSchema }])
  ],
  providers: [WatchesService],
  controllers: [WatchesController],
  exports: [WatchesService]
})
export class WatchesModule {}

