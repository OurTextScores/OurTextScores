import { BadRequestException, Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types/auth-user';
import { AuthOptionalGuard } from '../auth/guards/auth-optional.guard';
import { AuthRequiredGuard } from '../auth/guards/auth-required.guard';
import { ProjectsService } from './projects.service';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

@ApiTags('projects')
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Get()
  @UseGuards(AuthOptionalGuard)
  @ApiOperation({ summary: 'List projects' })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiQuery({ name: 'status', required: false, example: 'active' })
  @ApiQuery({ name: 'q', required: false, example: 'bach' })
  list(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @CurrentUser() user?: RequestUser
  ): Promise<any> {
    return this.projectsService.listProjects(
      {
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
        status,
        q
      },
      user ? { userId: user.userId, roles: user.roles } : undefined
    );
  }

  @Post()
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({ summary: 'Create project' })
  create(
    @Body('title') title: string,
    @Body('slug') slug: string | undefined,
    @Body('description') description: string | undefined,
    @Body('leadUserId') leadUserId: string | undefined,
    @Body('memberUserIds') memberUserIds: string[] | undefined,
    @Body('visibility') visibility: 'public' | 'private' | undefined,
    @Body('spreadsheetProvider') spreadsheetProvider: 'google' | undefined,
    @Body('spreadsheetEmbedUrl') spreadsheetEmbedUrl: string | undefined,
    @Body('spreadsheetExternalUrl') spreadsheetExternalUrl: string | undefined,
    @CurrentUser() user: RequestUser
  ): Promise<any> {
    return this.projectsService.createProject(
      {
        title,
        slug,
        description,
        leadUserId,
        memberUserIds,
        visibility,
        spreadsheetProvider,
        spreadsheetEmbedUrl,
        spreadsheetExternalUrl
      },
      { userId: user.userId, roles: user.roles }
    );
  }

  @Get(':projectId')
  @UseGuards(AuthOptionalGuard)
  @ApiOperation({ summary: 'Get project detail' })
  get(@Param('projectId') projectId: string, @CurrentUser() user?: RequestUser): Promise<any> {
    return this.projectsService.getProject(
      projectId,
      user ? { userId: user.userId, roles: user.roles } : undefined
    );
  }

  @Post(':projectId/join')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({ summary: 'Join a project as a member' })
  join(@Param('projectId') projectId: string, @CurrentUser() user: RequestUser): Promise<any> {
    return this.projectsService.joinProject(projectId, { userId: user.userId, roles: user.roles });
  }

  @Patch(':projectId')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({ summary: 'Update project metadata' })
  update(
    @Param('projectId') projectId: string,
    @Body() body: {
      title?: string;
      description?: string;
      leadUserId?: string;
      status?: 'active' | 'archived';
      visibility?: 'public' | 'private';
      spreadsheetProvider?: 'google' | null;
      spreadsheetEmbedUrl?: string | null;
      spreadsheetExternalUrl?: string | null;
    },
    @CurrentUser() user: RequestUser
  ): Promise<any> {
    return this.projectsService.updateProject(projectId, body, { userId: user.userId, roles: user.roles });
  }

  @Patch(':projectId/members')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({ summary: 'Add/remove project members' })
  updateMembers(
    @Param('projectId') projectId: string,
    @Body() body: { addUserIds?: string[]; removeUserIds?: string[] },
    @CurrentUser() user: RequestUser
  ): Promise<any> {
    return this.projectsService.updateMembers(projectId, body, { userId: user.userId, roles: user.roles });
  }

  @Delete(':projectId')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({ summary: 'Archive project' })
  archive(@Param('projectId') projectId: string, @CurrentUser() user: RequestUser): Promise<any> {
    return this.projectsService.archiveProject(projectId, { userId: user.userId, roles: user.roles });
  }

  @Get(':projectId/sources')
  @UseGuards(AuthOptionalGuard)
  @ApiOperation({ summary: 'List sources linked to a project' })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  listSources(
    @Param('projectId') projectId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @CurrentUser() user?: RequestUser
  ): Promise<any> {
    return this.projectsService.listSources(
      projectId,
      { limit: limit ? parseInt(limit, 10) : undefined, offset: offset ? parseInt(offset, 10) : undefined },
      user ? { userId: user.userId, roles: user.roles } : undefined
    );
  }

  @Delete(':projectId/sources/:sourceId')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({ summary: 'Remove a source from a project' })
  removeSource(
    @Param('projectId') projectId: string,
    @Param('sourceId') sourceId: string,
    @CurrentUser() user: RequestUser
  ): Promise<any> {
    return this.projectsService.removeSource(projectId, sourceId, { userId: user.userId, roles: user.roles });
  }

  @Post(':projectId/sources')
  @UseGuards(AuthRequiredGuard)
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'file', maxCount: 1 },
        { name: 'referencePdf', maxCount: 1 },
        { name: 'originalMscz', maxCount: 1 }
      ],
      {
        storage: memoryStorage(),
        limits: {
          fileSize: 100 * 1024 * 1024
        }
      }
    )
  )
  @ApiOperation({ summary: 'Upload a new source and attach it to a project' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
        referencePdf: { type: 'string', format: 'binary' },
        originalMscz: { type: 'string', format: 'binary' },
        workId: { type: 'string' },
        imslpUrl: { type: 'string' },
        label: { type: 'string' },
        sourceType: { type: 'string', enum: ['score', 'parts', 'audio', 'metadata', 'other'] },
        description: { type: 'string' },
        license: { type: 'string' },
        licenseUrl: { type: 'string' },
        licenseAttribution: { type: 'string' },
        rightsDeclarationAccepted: { type: 'boolean' },
        commitMessage: { type: 'string' },
        isPrimary: { type: 'boolean' },
        formatHint: { type: 'string' },
        createBranch: { type: 'boolean' },
        branchName: { type: 'string' }
      }
    }
  })
  async uploadSource(
    @Param('projectId') projectId: string,
    @Body() body: {
      workId?: string;
      imslpUrl?: string;
      label?: string;
      sourceType?: 'score' | 'parts' | 'audio' | 'metadata' | 'other';
      description?: string;
      license?: string;
      licenseUrl?: string;
      licenseAttribution?: string;
      rightsDeclarationAccepted?: boolean | string;
      commitMessage?: string;
      isPrimary?: boolean | string;
      formatHint?: string;
      createBranch?: boolean | string;
      branchName?: string;
    },
    @UploadedFiles() files: { file?: Express.Multer.File[]; referencePdf?: Express.Multer.File[]; originalMscz?: Express.Multer.File[] },
    @Headers('x-progress-id') progressId?: string,
    @CurrentUser() user?: RequestUser
  ): Promise<any> {
    const file = files?.file?.[0];
    if (!file) throw new BadRequestException('file is required');
    const referencePdfFile = files?.referencePdf?.[0];
    const originalMsczFile = files?.originalMscz?.[0];
    return this.projectsService.uploadSource(
      projectId,
      {
        workId: body.workId,
        imslpUrl: body.imslpUrl,
        label: body.label,
        sourceType: body.sourceType,
        description: body.description,
        license: body.license,
        licenseUrl: body.licenseUrl,
        licenseAttribution: body.licenseAttribution,
        rightsDeclarationAccepted: this.toBoolean(body.rightsDeclarationAccepted),
        commitMessage: body.commitMessage,
        isPrimary: this.toBoolean(body.isPrimary),
        formatHint: body.formatHint,
        createBranch: this.toBoolean(body.createBranch),
        branchName: body.branchName
      },
      file,
      referencePdfFile,
      originalMsczFile,
      progressId,
      user
    );
  }

  @Get(':projectId/rows')
  @UseGuards(AuthOptionalGuard)
  @ApiOperation({ summary: 'List project rows' })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  rows(
    @Param('projectId') projectId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @CurrentUser() user?: RequestUser
  ): Promise<any> {
    return this.projectsService.listRows(
      projectId,
      { limit: limit ? parseInt(limit, 10) : undefined, offset: offset ? parseInt(offset, 10) : undefined },
      user ? { userId: user.userId, roles: user.roles } : undefined
    );
  }

  @Post(':projectId/rows')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({ summary: 'Create project row' })
  createRow(
    @Param('projectId') projectId: string,
    @Body() body: { externalScoreUrl?: string; imslpUrl?: string; hasReferencePdf?: boolean; notes?: string },
    @CurrentUser() user: RequestUser
  ): Promise<any> {
    return this.projectsService.createRow(projectId, body, { userId: user.userId, roles: user.roles });
  }

  @Patch(':projectId/rows/:rowId')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({ summary: 'Update project row' })
  updateRow(
    @Param('projectId') projectId: string,
    @Param('rowId') rowId: string,
    @Body() body: { rowVersion?: number; externalScoreUrl?: string | null; imslpUrl?: string | null; hasReferencePdf?: boolean; verified?: boolean; notes?: string | null },
    @CurrentUser() user: RequestUser
  ): Promise<any> {
    return this.projectsService.updateRow(projectId, rowId, body, { userId: user.userId, roles: user.roles });
  }

  @Delete(':projectId/rows/:rowId')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({ summary: 'Delete project row' })
  @ApiResponse({ status: 200, description: 'Row deleted' })
  deleteRow(
    @Param('projectId') projectId: string,
    @Param('rowId') rowId: string,
    @CurrentUser() user: RequestUser
  ): Promise<any> {
    return this.projectsService.deleteRow(projectId, rowId, { userId: user.userId, roles: user.roles });
  }

  @Post(':projectId/rows/:rowId/create-source')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({ summary: 'Create or link internal source from project row' })
  createSource(
    @Param('projectId') projectId: string,
    @Param('rowId') rowId: string,
    @Body() body: { workId?: string; imslpUrl?: string; sourceId?: string; sourceLabel?: string; sourceType?: 'score' | 'parts' | 'audio' | 'metadata' | 'other' },
    @CurrentUser() user: RequestUser
  ): Promise<any> {
    return this.projectsService.createInternalSource(projectId, rowId, body, { userId: user.userId, roles: user.roles });
  }

  private toBoolean(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
    return undefined;
  }
}
