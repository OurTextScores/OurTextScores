import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  NotFoundException,
  Post,
  Query,
  Res,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import { AuthRequiredGuard } from '../auth/guards/auth-required.guard';
import { AdminRequiredGuard } from '../auth/guards/admin-required.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types/auth-user';
import { UsersService } from '../users/users.service';
import {
  resetUploadLimit,
  uploadLimitPolicy,
  uploadLimitState
} from '../common/middleware/rate-limit.middleware';
import { classifyUpload, UPLOAD_OPERATIONS } from './upload-health';
import { UploadOperationsService } from './upload-operations.service';

@Controller('operations')
export class OperationsController {
  constructor(
    private readonly operations: UploadOperationsService,
    private readonly users: UsersService,
    private readonly config: ConfigService
  ) {}

  @Get('uploads')
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthRequiredGuard, AdminRequiredGuard)
  async uploads(
    @Query('minutes') minutes?: string,
    @Query('operation') operation?: string,
    @Query('category') category?: string,
    @Query('role') role?: string
  ) {
    return {
      ...(await this.operations.summary({
        minutes: minutes ? Number(minutes) : 60,
        operation,
        category,
        role
      })),
      policy: uploadLimitPolicy()
    };
  }

  @Post('upload-observations')
  @UseGuards(AuthRequiredGuard)
  async observe(@Body() body: any, @CurrentUser() user: RequestUser) {
    if (
      !/^[a-f0-9-]{36}$/i.test(body?.attemptId || '') ||
      !UPLOAD_OPERATIONS.includes(body.operation) ||
      ![0, 413, 429].includes(body.status)
    )
      throw new BadRequestException('Invalid upload observation');
    const durationMs = Number(body.durationMs);
    if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 86400000)
      throw new BadRequestException('Invalid duration');
    await this.operations.record({
      attemptId: body.attemptId,
      operation: body.operation,
      status: body.status,
      durationMs,
      ...classifyUpload(body.status),
      observation: 'client',
      userId: user.userId,
      role: user.roles?.includes('admin') ? 'admin' : 'user'
    });
    return { ok: true };
  }

  private async account(account: string) {
    if (typeof account !== 'string' || !account.trim() || account.length > 200)
      throw new BadRequestException('An email or username is required');
    const value = account.trim();
    const user = value.includes('@')
      ? await this.users.findByEmail(value)
      : await this.users.findByUsername(value);
    if (!user) throw new NotFoundException('Account not found');
    return user;
  }

  @Get('upload-limits')
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthRequiredGuard, AdminRequiredGuard)
  async limits() {
    return this.limitsFor();
  }

  @Post('upload-limit-lookup')
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthRequiredGuard, AdminRequiredGuard)
  async lookupLimit(@Body() body: any) {
    if (!body?.account) throw new BadRequestException('An account is required');
    return this.limitsFor(body.account);
  }

  private async limitsFor(account?: string) {
    const user = account ? await this.account(account) : null;
    const userId = user ? String(user._id) : null;
    return {
      policy: uploadLimitPolicy(),
      account: user
        ? {
            userId,
            username: user.username,
            email: user.email,
            ...uploadLimitState(userId),
            allowance: await this.operations.allowance(userId)
          }
        : null,
      audit: await this.operations.limitsAudit()
    };
  }

  @Post('upload-limits')
  @UseGuards(AuthRequiredGuard, AdminRequiredGuard)
  async changeLimit(@Body() body: any, @CurrentUser() actor: RequestUser) {
    const target = await this.account(body?.account);
    const userId = String(target._id);
    const entry = await this.operations.changeLimit(actor.userId, userId, body);
    if (entry.action === 'reset') resetUploadLimit(userId);
    return { ok: true, action: entry.action, userId };
  }

  // A narrowly scoped machine credential exposes aggregate health only. It
  // cannot read failures/accounts or change quotas.
  @Get('upload-health/check')
  async check(
    @Headers('x-operations-monitor-token') token: string,
    @Res({ passthrough: true }) res: Response
  ) {
    res.setHeader('Cache-Control', 'no-store');
    const expected = this.config.get<string>('OPERATIONS_MONITOR_TOKEN', '');
    const actual = typeof token === 'string' ? token : '';
    if (
      !expected ||
      Buffer.byteLength(expected) !== Buffer.byteLength(actual) ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
    )
      throw new UnauthorizedException();
    const report = await this.operations.summary({ minutes: 15 });
    const disabled = uploadLimitPolicy().disabled;
    return {
      status: disabled ? 'down' : report.health.status,
      incidents: disabled
        ? [
            ...report.health.incidents,
            'Upload rate limiting is disabled by maintenance configuration'
          ]
        : report.health.incidents,
      generatedAt: report.generatedAt,
      windowMinutes: 15,
      counts: report.totals,
      writeFailures: report.telemetry.writeFailures
    };
  }
}
