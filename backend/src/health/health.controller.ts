import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @Throttle({ default: { limit: 200, ttl: 60000 } }) // 200 requests per minute - generous for monitoring
  @ApiOperation({
    summary: 'Health check',
    description: 'Returns the health status of the API server'
  })
  @ApiResponse({
    status: 200,
    description: 'Server is healthy',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'ok' },
        time: { type: 'string', format: 'date-time', example: '2025-11-08T12:00:00.000Z' }
      }
    }
  })
  get() {
    return {
      status: 'ok',
      time: new Date().toISOString()
    };
  }
}

