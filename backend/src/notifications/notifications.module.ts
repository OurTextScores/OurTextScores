import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { NotificationOutbox, NotificationOutboxSchema } from './schemas/outbox.schema';
import { NotificationInbox, NotificationInboxSchema } from './schemas/inbox.schema';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { UsersModule } from '../users/users.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    AuthModule,
    UsersModule,
    MongooseModule.forFeature([
      { name: NotificationOutbox.name, schema: NotificationOutboxSchema },
      { name: NotificationInbox.name, schema: NotificationInboxSchema }
    ])
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService]
})
export class NotificationsModule {}

