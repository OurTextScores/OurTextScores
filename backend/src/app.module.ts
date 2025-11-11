import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { WorksModule } from './works/works.module';
import { UsersModule } from './users/users.module';
import { FossilModule } from './fossil/fossil.module';
import { ProgressModule } from './progress/progress.module';
import { SearchModule } from './search/search.module';
import { StorageModule } from './storage/storage.module';
import { ImslpModule } from './imslp/imslp.module';
import { AuthModule } from './auth/auth.module';
import { BranchesModule } from './branches/branches.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const uri = config.get<string>(
          'MONGO_URI',
          'mongodb://localhost:27017/ourtextscores'
        );

        return {
          uri,
          autoIndex: config.get<string>('MONGO_AUTO_INDEX', 'false') === 'true'
        };
      }
    }),
    StorageModule,
    ImslpModule,
    AuthModule,
    BranchesModule,
    NotificationsModule,
    WorksModule,
    UsersModule,
    FossilModule,
    ProgressModule,
    SearchModule,
    HealthModule,
    ApprovalsModule
  ]
})
export class AppModule {}
