import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { LegalService } from './legal.service';
import { AuthRequiredGuard } from '../auth/guards/auth-required.guard';
import { AdminRequiredGuard } from '../auth/guards/admin-required.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types/auth-user';

@ApiTags('legal')
@Controller('legal/dmca')
export class LegalController {
  constructor(private readonly legalService: LegalService) {}

  @Post('notices')
  @ApiOperation({
    summary: 'Submit DMCA takedown notice',
    description:
      'Public endpoint to submit a takedown notice. Creates a new case for moderator review.'
  })
  @ApiResponse({ status: 201, description: 'Notice submitted and case created' })
  submitNotice(
    @Body()
    body: {
      workId: string;
      sourceId: string;
      revisionId?: string;
      complainantName: string;
      complainantEmail: string;
      organization?: string;
      address?: string;
      phone?: string;
      claimedWork: string;
      infringementStatement: string;
      goodFaithStatement: boolean;
      perjuryStatement: boolean;
      signature: string;
    },
    @Req() req: Request & { requestId?: string }
  ) {
    return this.legalService.submitNotice(body, {
      requestIp: req.ip,
      requestId: req.requestId
    });
  }

  @Post('counter-notices')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Submit counter notice',
    description:
      'Authenticated endpoint for uploader/admin to submit a counter notice for an existing case.'
  })
  @ApiResponse({ status: 201, description: 'Counter notice submitted' })
  submitCounterNotice(
    @CurrentUser() user: RequestUser,
    @Body()
    body: {
      caseId: string;
      fullName: string;
      address: string;
      phone: string;
      email: string;
      statement: string;
      consentToJurisdiction: boolean;
      signature: string;
    },
    @Req() req: Request & { requestId?: string }
  ) {
    return this.legalService.submitCounterNotice(user, body, {
      requestIp: req.ip,
      requestId: req.requestId
    });
  }

  @Get('cases')
  @UseGuards(AuthRequiredGuard, AdminRequiredGuard)
  @ApiOperation({
    summary: 'List DMCA cases (admin only)'
  })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  listCases(
    @Query('status') status?: string,
    @Query('limit') limit = '50',
    @Query('offset') offset = '0'
  ) {
    const parsedLimit = Math.max(1, Math.min(parseInt(limit, 10) || 50, 200));
    const parsedOffset = Math.max(0, parseInt(offset, 10) || 0);
    return this.legalService.listCases({
      status: status as any,
      limit: parsedLimit,
      offset: parsedOffset
    });
  }

  @Get('cases/:caseId')
  @UseGuards(AuthRequiredGuard, AdminRequiredGuard)
  @ApiOperation({ summary: 'Get DMCA case detail (admin only)' })
  getCase(@Param('caseId') caseId: string) {
    return this.legalService.getCaseDetail(caseId);
  }

  @Get('metrics')
  @UseGuards(AuthRequiredGuard, AdminRequiredGuard)
  @ApiOperation({ summary: 'Get DMCA compliance metrics (admin only)' })
  @ApiQuery({ name: 'days', required: false, example: 90 })
  getMetrics(@Query('days') days = '90') {
    const parsedDays = Math.max(1, Math.min(parseInt(days, 10) || 90, 365));
    return this.legalService.getComplianceMetrics(parsedDays);
  }

  @Post('cases/:caseId/withhold')
  @UseGuards(AuthRequiredGuard, AdminRequiredGuard)
  @ApiOperation({ summary: 'Withhold content for case (admin only)' })
  withholdCase(
    @Param('caseId') caseId: string,
    @CurrentUser() user: RequestUser,
    @Body('reason') reason?: string
  ) {
    return this.legalService.withholdCase(caseId, user, reason);
  }

  @Post('cases/:caseId/restore')
  @UseGuards(AuthRequiredGuard, AdminRequiredGuard)
  @ApiOperation({ summary: 'Restore content for case (admin only)' })
  restoreCase(@Param('caseId') caseId: string, @CurrentUser() user: RequestUser) {
    return this.legalService.restoreCase(caseId, user);
  }

  @Patch('cases/:caseId/status')
  @UseGuards(AuthRequiredGuard, AdminRequiredGuard)
  @ApiOperation({ summary: 'Set DMCA case status (admin only)' })
  setStatus(
    @Param('caseId') caseId: string,
    @CurrentUser() user: RequestUser,
    @Body() body: { status: string; reviewNote?: string }
  ) {
    const allowed = new Set([
      'notice_received',
      'pending_review',
      'content_disabled',
      'counter_notice_received',
      'restored',
      'rejected',
      'withdrawn'
    ]);
    if (!body?.status || !allowed.has(body.status)) {
      throw new BadRequestException('Invalid status');
    }
    return this.legalService.setCaseStatus(caseId, body.status as any, user, body.reviewNote);
  }
}
