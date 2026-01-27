import { Controller, Get, Post, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { AuthRequiredGuard } from '../auth/guards/auth-required.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequestUser } from '../auth/types/auth-user';

@Controller('notifications')
@ApiTags('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Get user notifications',
    description: 'Retrieve all notifications for the current user'
  })
  @ApiResponse({ status: 200, description: 'List of notifications' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getUserNotifications(@CurrentUser() user: RequestUser) {
    const notifications = await this.notificationsService.getUserNotifications(user.userId);
    const unreadCount = await this.notificationsService.getUnreadCount(user.userId);
    return { notifications, unreadCount };
  }

  @Get('unread-count')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Get unread notification count',
    description: 'Get count of unread notifications for the current user'
  })
  @ApiResponse({ status: 200, description: 'Unread count' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getUnreadCount(@CurrentUser() user: RequestUser) {
    const count = await this.notificationsService.getUnreadCount(user.userId);
    return { unreadCount: count };
  }

  @Post(':notificationId/read')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Mark notification as read',
    description: 'Mark a specific notification as read'
  })
  @ApiParam({ name: 'notificationId', description: 'Notification ID' })
  @ApiResponse({ status: 200, description: 'Notification marked as read' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async markAsRead(
    @Param('notificationId') notificationId: string,
    @CurrentUser() user: RequestUser
  ) {
    return this.notificationsService.markNotificationAsRead(notificationId, user.userId);
  }

  @Post('mark-all-read')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Mark all notifications as read',
    description: 'Mark all notifications as read for the current user'
  })
  @ApiResponse({ status: 200, description: 'All notifications marked as read' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async markAllAsRead(@CurrentUser() user: RequestUser) {
    return this.notificationsService.markAllAsRead(user.userId);
  }
}
