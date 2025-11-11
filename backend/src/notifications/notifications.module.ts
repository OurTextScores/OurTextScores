import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { NotificationOutbox, NotificationOutboxSchema } from './schemas/outbox.schema';
import { NotificationsService } from './notifications.service';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    UsersModule,
    MongooseModule.forFeature([{ name: NotificationOutbox.name, schema: NotificationOutboxSchema }])
  ],
  providers: [NotificationsService],
  exports: [NotificationsService]
})
export class NotificationsModule {}

