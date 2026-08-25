import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UsersModule } from '../users/users.module';
import { AuthOptionalGuard } from './guards/auth-optional.guard';
import { AuthRequiredGuard } from './guards/auth-required.guard';
import { PublicExampleAccessGuard } from './guards/public-example-access.guard';

@Module({
  imports: [ConfigModule, forwardRef(() => UsersModule)],
  controllers: [AuthController],
  providers: [AuthService, AuthOptionalGuard, AuthRequiredGuard, PublicExampleAccessGuard],
  // Re-export UsersModule so guards' UsersService dependency resolves
  exports: [
    AuthService,
    AuthOptionalGuard,
    AuthRequiredGuard,
    PublicExampleAccessGuard,
    UsersModule
  ]
})
export class AuthModule {}
