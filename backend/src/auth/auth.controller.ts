import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthOptionalGuard } from './guards/auth-optional.guard';
import { CurrentUser } from './current-user.decorator';
import { RequestUser } from './types/auth-user';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  @Get('session')
  @UseGuards(AuthOptionalGuard)
  @ApiOperation({
    summary: 'Get current session',
    description: 'Returns the current authenticated user session, or null if not authenticated'
  })
  @ApiResponse({
    status: 200,
    description: 'Session information retrieved',
    schema: {
      type: 'object',
      properties: {
        user: {
          oneOf: [
            {
              type: 'object',
              properties: {
                userId: { type: 'string', example: '507f1f77bcf86cd799439011' },
                email: { type: 'string', example: 'user@example.com' },
                roles: { type: 'array', items: { type: 'string' }, example: ['user'] }
              }
            },
            { type: 'null' }
          ]
        }
      }
    }
  })
  session(@CurrentUser() user?: RequestUser) {
    return { user: user ?? null };
  }
}

