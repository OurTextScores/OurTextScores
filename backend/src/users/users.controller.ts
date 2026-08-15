import { BadRequestException, Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { UsersService } from './users.service';
import { AuthRequiredGuard } from '../auth/guards/auth-required.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types/auth-user';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import {
  NOTIFICATION_EMAIL_CATEGORIES,
  isNotificationEmailCategory,
  notificationPreferencesWithDefaults,
  type NotificationEmailCategories
} from './notification-preferences';

@ApiTags('users')
@Controller('users/me')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Get current user profile',
    description: 'Get the profile information for the authenticated user. Requires authentication.'
  })
  @ApiResponse({
    status: 200,
    description: 'User profile retrieved',
    schema: {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: {
            id: { type: 'string', example: '507f1f77bcf86cd799439011' },
            email: { type: 'string', example: 'user@example.com' },
            displayName: { type: 'string', example: 'John Doe' },
            username: { type: 'string', example: 'johndoe' },
            roles: { type: 'array', items: { type: 'string' }, example: ['user'] },
            status: { type: 'string', enum: ['active', 'suspended', 'terminated'], example: 'active' },
            notify: {
              type: 'object',
              properties: {
                watchPreference: {
                  type: 'string',
                  enum: ['immediate', 'daily', 'weekly'],
                  example: 'immediate'
                },
                emailEnabled: { type: 'boolean', example: true },
                emailCategories: {
                  type: 'object',
                  properties: Object.fromEntries(
                    NOTIFICATION_EMAIL_CATEGORIES.map((category) => [
                      category,
                      { type: 'boolean' }
                    ])
                  )
                }
              }
            }
          }
        }
      }
    }
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async me(@CurrentUser() user: RequestUser) {
    const doc = await this.users.findById(user.userId);
    if (!doc) return { user: null };
    return {
      user: {
        id: String(doc._id),
        email: doc.email,
        displayName: doc.displayName,
        username: doc.username,
        roles: doc.roles,
        ...(doc.status ? { status: doc.status } : {}),
        notify: notificationPreferencesWithDefaults(doc.notify)
      }
    };
  }

  @Patch()
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Update user profile',
    description: 'Update profile information (username) for the authenticated user. Requires authentication.'
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        username: { type: 'string', example: 'johndoe', description: 'Unique username (lowercase, alphanumeric + underscores, 3-20 chars)', pattern: '^[a-z0-9_]{3,20}$' }
      }
    }
  })
  @ApiResponse({
    status: 200,
    description: 'Profile updated successfully',
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', example: true },
        error: { type: 'string', example: 'Username already taken' }
      }
    }
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async updateProfile(
    @CurrentUser() user: RequestUser,
    @Body('username') username?: string
  ) {
    const doc = await this.users.findById(user.userId);
    if (!doc) return { ok: false, error: 'User not found' };

    // Validate and update username
    if (username !== undefined) {
      const normalized = username.trim().toLowerCase();
      if (normalized && !/^[a-z0-9_]{3,20}$/.test(normalized)) {
        return { ok: false, error: 'Username must be 3-20 characters (lowercase letters, numbers, underscores only)' };
      }
      // Check if username is already taken by another user
      if (normalized && normalized !== doc.username) {
        const existing = await this.users.findByUsername(normalized);
        if (existing && String(existing._id) !== String(doc._id)) {
          return { ok: false, error: 'Username already taken' };
        }
      }
      doc.username = normalized || undefined;
    }

    await doc.save();
    return { ok: true };
  }

  @Patch('preferences')
  @UseGuards(AuthRequiredGuard)
  @ApiOperation({
    summary: 'Update user preferences',
    description: 'Update notification preferences for the authenticated user. Requires authentication.'
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        watchPreference: {
          type: 'string',
          enum: ['immediate', 'daily', 'weekly'],
          example: 'daily',
          description: 'How often to receive notification emails'
        },
        emailEnabled: {
          type: 'boolean',
          example: true,
          description: 'Catch-all switch for notification email delivery'
        },
        emailCategories: {
          type: 'object',
          description: 'Per-category email delivery switches; in-app notifications are unaffected',
          properties: Object.fromEntries(
            NOTIFICATION_EMAIL_CATEGORIES.map((category) => [category, { type: 'boolean' }])
          )
        }
      }
    }
  })
  @ApiResponse({ status: 200, description: 'Preferences updated successfully', schema: { type: 'object', properties: { ok: { type: 'boolean', example: true } } } })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async updatePreferences(
    @CurrentUser() user: RequestUser,
    @Body()
    body: {
      watchPreference?: 'immediate' | 'daily' | 'weekly';
      emailEnabled?: boolean;
      emailCategories?: NotificationEmailCategories;
    }
  ) {
    const doc = await this.users.findById(user.userId);
    if (!doc) return { ok: false };

    const preferences = notificationPreferencesWithDefaults(doc.notify);
    if (body.watchPreference !== undefined) {
      if (!['immediate', 'daily', 'weekly'].includes(body.watchPreference)) {
        throw new BadRequestException('Invalid notification email frequency');
      }
      preferences.watchPreference = body.watchPreference;
    }
    if (body.emailEnabled !== undefined) {
      if (typeof body.emailEnabled !== 'boolean') {
        throw new BadRequestException('emailEnabled must be a boolean');
      }
      preferences.emailEnabled = body.emailEnabled;
    }
    if (body.emailCategories !== undefined) {
      if (
        !body.emailCategories ||
        typeof body.emailCategories !== 'object' ||
        Array.isArray(body.emailCategories)
      ) {
        throw new BadRequestException('emailCategories must be an object');
      }
      for (const [category, enabled] of Object.entries(body.emailCategories)) {
        if (
          !isNotificationEmailCategory(category) || typeof enabled !== 'boolean'
        ) {
          throw new BadRequestException(`Invalid notification email category: ${category}`);
        }
        preferences.emailCategories[category] = enabled;
      }
    }
    doc.notify = preferences;
    await doc.save();
    return { ok: true, notify: preferences };
  }
}
