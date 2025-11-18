import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
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
import { UserAwareThrottlerGuard } from './common/throttler/user-aware-throttler.guard';

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
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: parseInt(config.get<string>('RATE_LIMIT_TTL', '60000'), 10), // 1 minute default
            limit: parseInt(config.get<string>('RATE_LIMIT_MAX', '100'), 10), // 100 requests/min default
          },
        ],
      }),
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
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: UserAwareThrottlerGuard,
    },
  ],
})
export class AppModule {}
