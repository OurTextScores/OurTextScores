import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { BranchesService } from './branches.service';
import { AuthRequiredGuard } from '../auth/guards/auth-required.guard';
import { AuthOptionalGuard } from '../auth/guards/auth-optional.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types/auth-user';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBody } from '@nestjs/swagger';

@ApiTags('branches')
@Controller('works/:workId/sources/:sourceId/branches')
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Get()
  @UseGuards(AuthOptionalGuard)
  @ApiOperation({
    summary: 'List branches',
    description: 'Get all branches for a source in the Fossil VCS repository'
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiResponse({
    status: 200,
    description: 'List of branches',
    schema: {
      type: 'object',
      properties: {
        branches: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', example: 'trunk' },
              policy: { type: 'string', enum: ['public', 'owner_approval'], example: 'public' },
              ownerUserId: { type: 'string', nullable: true },
              baseRevisionId: { type: 'string', nullable: true }
            }
          }
        }
      }
    }
  })
  async list(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string
  ) {
    const branches = await this.branches.listBranches(workId, sourceId);
    return { branches };
  }

  @Post()
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Create a branch',
    description: 'Create a new branch in the Fossil VCS repository. Requires authentication.'
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name', 'policy'],
      properties: {
        name: { type: 'string', example: 'feature-improvements', description: 'Branch name' },
        policy: { type: 'string', enum: ['public', 'owner_approval'], example: 'public', description: 'Branch policy' },
        ownerUserId: { type: 'string', description: 'Owner user ID (defaults to current user for owner_approval policy)' },
        baseRevisionId: { type: 'string', description: 'The revision this branch is created from (typically the latest revision)' }
      }
    }
  })
  @ApiResponse({ status: 201, description: 'Branch created successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async create(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Body('name') name: string,
    @Body('policy') policy: 'public' | 'owner_approval',
    @Body('ownerUserId') ownerUserId: string | undefined,
    @Body('baseRevisionId') baseRevisionId: string | undefined,
    @CurrentUser() user: RequestUser
  ) {
    // If policy is owner_approval and no owner specified, default to current user
    const finalOwner = policy === 'owner_approval' ? (ownerUserId || user?.userId) : ownerUserId;
    const created = await this.branches.createBranch({ workId, sourceId, name, policy, ownerUserId: finalOwner, baseRevisionId });
    return { branch: created };
  }

  @Patch(':branchName')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Update branch settings',
    description: 'Update branch policy and owner. Requires authentication and appropriate permissions.'
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiParam({ name: 'branchName', description: 'Branch name', example: 'trunk' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        policy: { type: 'string', enum: ['public', 'owner_approval'], description: 'Branch policy' },
        ownerUserId: { type: 'string', description: 'Owner user ID' }
      }
    }
  })
  @ApiResponse({ status: 200, description: 'Branch updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - insufficient permissions' })
  async update(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Param('branchName') branchName: string,
    @Body('policy') policy: 'public' | 'owner_approval' | undefined,
    @Body('ownerUserId') ownerUserId: string | undefined,
    @CurrentUser() user: RequestUser
  ) {
    // Default owner to current user when switching to owner_approval and no owner assigned yet
    const desiredPolicy = policy as any;
    let owner = ownerUserId;
    if (desiredPolicy === 'owner_approval' && !owner) {
      owner = user.userId;
    }
    const updated = await this.branches.updateBranch(
      workId,
      sourceId,
      this.branches.sanitizeName(branchName),
      { policy: desiredPolicy, ownerUserId: owner },
      { userId: user.userId, roles: user.roles }
    );
    return { branch: updated };
  }

  @Delete(':branchName')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Delete a branch',
    description: 'Delete a branch from the Fossil VCS repository. Requires authentication and appropriate permissions.'
  })
  @ApiParam({ name: 'workId', description: 'Work ID', example: '164349' })
  @ApiParam({ name: 'sourceId', description: 'Source ID' })
  @ApiParam({ name: 'branchName', description: 'Branch name to delete' })
  @ApiResponse({ status: 200, description: 'Branch deleted successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - cannot delete protected branches or insufficient permissions' })
  async remove(
    @Param('workId') workId: string,
    @Param('sourceId') sourceId: string,
    @Param('branchName') branchName: string,
    @CurrentUser() user: RequestUser
  ) {
    const out = await this.branches.deleteBranch(
      workId,
      sourceId,
      this.branches.sanitizeName(branchName),
      { userId: user.userId, roles: user.roles }
    );
    return out;
  }
}
