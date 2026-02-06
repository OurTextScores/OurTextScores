import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types/auth-user';
import { AuthOptionalGuard } from '../auth/guards/auth-optional.guard';
import { AuthRequiredGuard } from '../auth/guards/auth-required.guard';
import { ProjectsService } from './projects.service';

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
    @CurrentUser() user: RequestUser
  ): Promise<any> {
    return this.projectsService.createProject(
      { title, slug, description, leadUserId, memberUserIds, visibility },
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

  @Patch(':projectId')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({ summary: 'Update project metadata' })
  update(
    @Param('projectId') projectId: string,
    @Body() body: { title?: string; description?: string; leadUserId?: string; status?: 'active' | 'archived'; visibility?: 'public' | 'private' },
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
}
