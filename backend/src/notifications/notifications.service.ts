import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { NotificationOutbox, NotificationOutboxDocument } from './schemas/outbox.schema';
import { NotificationInbox, NotificationInboxDocument } from './schemas/inbox.schema';
import { UsersService } from '../users/users.service';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { randomUUID } from 'crypto';

@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private timer: NodeJS.Timeout | null = null;
  private transporter: nodemailer.Transporter | null = null;
  private emailFrom: string = 'OurTextScores <noreply@example.com>';
  private publicWebBaseUrl: string = 'http://localhost:3000';
  constructor(
    @InjectModel(NotificationOutbox.name)
    private readonly outboxModel: Model<NotificationOutboxDocument>,
    @InjectModel(NotificationInbox.name)
    private readonly inboxModel: Model<NotificationInboxDocument>,
    private readonly users: UsersService,
    private readonly config: ConfigService
  ) {}

  async queuePushRequest(params: { workId: string; sourceId: string; revisionId: string; ownerUserId?: string }) {
    const recipients: string[] = [];
    if (params.ownerUserId) recipients.push(`user:${params.ownerUserId}`);
    await this.outboxModel.create({
      type: 'push_request',
      workId: params.workId,
      sourceId: params.sourceId,
      revisionId: params.revisionId,
      recipients,
      payload: {}
    });
  }

  async queueNewRevision(params: { workId: string; sourceId: string; revisionId: string; userIds: string[]; actorUserId?: string }) {
    // Create in-app notifications for all watchers
    for (const id of params.userIds) {
      try {
        await this.createNotification({
          userId: id,
          type: 'new_revision',
          workId: params.workId,
          sourceId: params.sourceId,
          revisionId: params.revisionId,
          payload: { actorUserId: params.actorUserId }
        });
      } catch {
        // ignore per-user failures
      }
    }
  }

  async queueCommentReply(params: { workId: string; sourceId: string; revisionId: string; commentId: string; recipientUserId: string; actorUserId: string }) {
    // Create in-app notification
    await this.createNotification({
      userId: params.recipientUserId,
      type: 'comment_reply',
      workId: params.workId,
      sourceId: params.sourceId,
      revisionId: params.revisionId,
      payload: { commentId: params.commentId, actorUserId: params.actorUserId }
    });
  }

  async queueSourceComment(params: { workId: string; sourceId: string; revisionId: string; commentId: string; recipientUserId: string; actorUserId: string }) {
    // Create in-app notification
    await this.createNotification({
      userId: params.recipientUserId,
      type: 'source_comment',
      workId: params.workId,
      sourceId: params.sourceId,
      revisionId: params.revisionId,
      payload: { commentId: params.commentId, actorUserId: params.actorUserId }
    });
  }

  /**
   * Create an in-app notification
   */
  async createNotification(params: {
    userId: string;
    type: 'comment_reply' | 'source_comment' | 'new_revision';
    workId: string;
    sourceId: string;
    revisionId: string;
    payload: Record<string, any>;
  }): Promise<void> {
    const notificationId = randomUUID();
    await this.inboxModel.create({
      notificationId,
      userId: params.userId,
      type: params.type,
      workId: params.workId,
      sourceId: params.sourceId,
      revisionId: params.revisionId,
      payload: params.payload,
      read: false,
      createdAt: new Date()
    });
  }

  /**
   * Get user's notifications
   */
  async getUserNotifications(userId: string, unreadOnly = false): Promise<any[]> {
    const query: any = { userId };
    if (unreadOnly) {
      query.read = false;
    }

    const notifications = await this.inboxModel
      .find(query)
      .sort({ createdAt: -1 })
      .limit(100)
      .exec();

    // Get actor usernames
    const actorIds = notifications
      .map(n => n.payload?.actorUserId)
      .filter(Boolean) as string[];

    const userMap = new Map<string, string>();
    for (const uid of actorIds) {
      try {
        const user = await this.users.findById(uid);
        if (user) {
          userMap.set(uid, user.username || user.email || 'Unknown');
        }
      } catch {
        // ignore
      }
    }

    return notifications.map(n => ({
      notificationId: n.notificationId,
      type: n.type,
      workId: n.workId,
      sourceId: n.sourceId,
      revisionId: n.revisionId,
      payload: n.payload,
      actorUsername: n.payload?.actorUserId ? userMap.get(n.payload.actorUserId) : undefined,
      read: n.read,
      createdAt: n.createdAt
    }));
  }

  /**
   * Get unread notification count for a user
   */
  async getUnreadCount(userId: string): Promise<number> {
    return this.inboxModel.countDocuments({ userId, read: false }).exec();
  }

  /**
   * Mark notification as read
   */
  async markNotificationAsRead(notificationId: string, userId: string): Promise<{ ok: true }> {
    await this.inboxModel.updateOne(
      { notificationId, userId },
      { $set: { read: true } }
    ).exec();
    return { ok: true };
  }

  /**
   * Mark all notifications as read for a user
   */
  async markAllAsRead(userId: string): Promise<{ ok: true }> {
    await this.inboxModel.updateMany(
      { userId, read: false },
      { $set: { read: true } }
    ).exec();
    return { ok: true };
  }

  onModuleInit() {
    // Simple polling loop without external deps
    this.timer = setInterval(() => {
      this.processOutbox().catch(() => {});
    }, 10_000);
    const emailServer = this.config.get<string>('EMAIL_SERVER');
    const from = this.config.get<string>('EMAIL_FROM');
    const web = this.config.get<string>('PUBLIC_WEB_BASE_URL');
    if (emailServer) {
      try {
        this.transporter = nodemailer.createTransport(emailServer);
      } catch (e) {
        this.logger.warn('Failed to configure email transporter');
      }
    }
    if (from) this.emailFrom = from;
    if (web) this.publicWebBaseUrl = web.replace(/\/$/, '');
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer as NodeJS.Timeout);
  }

  // Process outbox for approval requests only
  async processOutbox(): Promise<void> {
    // Process push_request notifications (approvals)
    const batch = await this.outboxModel.find({ status: 'queued', type: 'push_request' }).sort({ createdAt: 1 }).limit(10).exec();
    for (const n of batch) {
      try {
        const emails: string[] = [];
        for (const r of n.recipients) {
          if (r.startsWith('user:')) {
            const id = r.substring('user:'.length);
            const user = await this.users.findById(id);
            if (user?.email) emails.push(user.email);
          } else if (r.includes('@')) {
            emails.push(r);
          }
        }
        if (emails.length > 0 && this.transporter) {
          const subject = this.renderSubject(n.type, n.workId, n.sourceId, n.revisionId);
          const html = this.renderHtml(n.type, n.workId, n.sourceId, n.revisionId);
          await this.transporter.sendMail({ from: this.emailFrom, to: emails.join(','), subject, html });
        } else {
          this.logger.log(`Outbox ${n.type} ${n.revisionId} -> ${emails.join(', ') || '(no recipients)'} (no transporter)`);
        }
        n.status = 'sent';
        n.sentAt = new Date();
        n.attempts += 1;
        await n.save();
      } catch (err: any) {
        n.status = 'error';
        n.attempts += 1;
        n.lastError = String(err?.message || err) ?? 'error';
        await n.save();
      }
    }

    // Process in-app notification email digests
    await this.processInboxDigests();
  }

  /**
   * Process in-app notifications and send email digests based on user preference
   */
  private async processInboxDigests(): Promise<void> {
    // Get all users with unemailed notifications
    const notifications = await this.inboxModel
      .find({ emailSent: { $ne: true } })
      .sort({ createdAt: 1 })
      .exec();

    if (notifications.length === 0) return;

    // Group by user
    const byUser = new Map<string, typeof notifications>();
    for (const n of notifications) {
      const list = byUser.get(n.userId) || [];
      list.push(n);
      byUser.set(n.userId, list);
    }

    const now = new Date();

    for (const [userId, userNotifications] of byUser) {
      try {
        const user = await this.users.findById(userId);
        if (!user?.email) continue;

        const preference = user.notify?.watchPreference || 'immediate';

        if (preference === 'immediate') {
          // Send email for each notification immediately
          for (const notification of userNotifications) {
            if (this.transporter) {
              const subject = this.renderNotificationSubject(notification);
              const html = this.renderNotificationHtml(notification);
              await this.transporter.sendMail({
                from: this.emailFrom,
                to: user.email,
                subject,
                html
              });
            }
            notification.emailSent = true;
            notification.emailSentAt = now;
            await notification.save();
          }
        } else {
          // Send digest (daily or weekly)
          const threshold = preference === 'daily'
            ? new Date(now.getTime() - 24 * 60 * 60 * 1000)
            : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

          // Only send digest if notifications are old enough
          const oldNotifications = userNotifications.filter(n => n.createdAt <= threshold);
          if (oldNotifications.length === 0) continue;

          if (this.transporter) {
            const subject = `[${preference} digest] ${oldNotifications.length} new notification${oldNotifications.length > 1 ? 's' : ''}`;
            const html = this.renderDigestHtml(oldNotifications);
            await this.transporter.sendMail({
              from: this.emailFrom,
              to: user.email,
              subject,
              html
            });
          }

          // Mark as emailed
          for (const notification of oldNotifications) {
            notification.emailSent = true;
            notification.emailSentAt = now;
            await notification.save();
          }
        }
      } catch (err) {
        this.logger.error(`Failed to send notification digest to ${userId}:`, err);
        continue;
      }
    }
  }


  private renderSubject(type: string, workId: string, sourceId: string, revisionId: string): string {
    switch (type) {
      case 'push_request':
        return `Approval requested for ${workId}/${sourceId} (${revisionId})`;
      case 'comment_reply':
        return `New reply to your comment on ${workId}`;
      case 'source_comment':
        return `New comment on your source ${workId}/${sourceId}`;
      case 'new_revision':
      default:
        return `New revision on ${workId}/${sourceId} (${revisionId})`;
    }
  }

  private renderHtml(type: string, workId: string, sourceId: string, revisionId: string): string {
    const workUrl = `${this.publicWebBaseUrl}/works/${encodeURIComponent(workId)}`;
    const approvalsUrl = `${this.publicWebBaseUrl}/approvals`;

    if (type === 'push_request') {
      return `
        <p>A new revision <code>${revisionId}</code> requires your approval.</p>
        <p>Source: <code>${workId}/${sourceId}</code></p>
        <p><a href="${approvalsUrl}">Open approvals inbox</a> • <a href="${workUrl}">View work</a></p>
      `;
    }

    if (type === 'comment_reply') {
      return `
        <p>Someone replied to your comment on revision <code>${revisionId}</code>.</p>
        <p>Work: <code>${workId}</code></p>
        <p><a href="${workUrl}">View comments</a></p>
      `;
    }

    if (type === 'source_comment') {
      return `
        <p>Someone commented on revision <code>${revisionId}</code> of your source.</p>
        <p>Source: <code>${workId}/${sourceId}</code></p>
        <p><a href="${workUrl}">View comments</a></p>
      `;
    }

    return `
      <p>A new revision <code>${revisionId}</code> was approved.</p>
      <p>Source: <code>${workId}/${sourceId}</code></p>
      <p><a href="${workUrl}">View work</a></p>
    `;
  }

  private renderNotificationSubject(notification: NotificationInboxDocument): string {
    switch (notification.type) {
      case 'comment_reply':
        return `New reply to your comment on ${notification.workId}`;
      case 'source_comment':
        return `New comment on your source ${notification.workId}/${notification.sourceId}`;
      case 'new_revision':
        return `New revision on ${notification.workId}/${notification.sourceId}`;
      default:
        return `New notification from OurTextScores`;
    }
  }

  private renderNotificationHtml(notification: NotificationInboxDocument): string {
    const workUrl = `${this.publicWebBaseUrl}/works/${encodeURIComponent(notification.workId)}`;
    const notificationsUrl = `${this.publicWebBaseUrl}/notifications`;

    switch (notification.type) {
      case 'comment_reply':
        return `
          <p>Someone replied to your comment.</p>
          <p>Work: <code>${notification.workId}</code></p>
          <p>Revision: <code>${notification.revisionId}</code></p>
          <p><a href="${workUrl}">View comments</a> • <a href="${notificationsUrl}">See all notifications</a></p>
        `;
      case 'source_comment':
        return `
          <p>Someone commented on your source.</p>
          <p>Source: <code>${notification.workId}/${notification.sourceId}</code></p>
          <p>Revision: <code>${notification.revisionId}</code></p>
          <p><a href="${workUrl}">View comments</a> • <a href="${notificationsUrl}">See all notifications</a></p>
        `;
      case 'new_revision':
        return `
          <p>A new revision was uploaded to a work you're watching.</p>
          <p>Source: <code>${notification.workId}/${notification.sourceId}</code></p>
          <p>Revision: <code>${notification.revisionId}</code></p>
          <p><a href="${workUrl}">View work</a> • <a href="${notificationsUrl}">See all notifications</a></p>
        `;
      default:
        return `
          <p>You have a new notification from OurTextScores.</p>
          <p><a href="${notificationsUrl}">View notification</a></p>
        `;
    }
  }

  private renderDigestHtml(notifications: NotificationInboxDocument[]): string {
    const notificationsUrl = `${this.publicWebBaseUrl}/notifications`;

    const lines = notifications.map(n => {
      const workUrl = `${this.publicWebBaseUrl}/works/${encodeURIComponent(n.workId)}`;
      let typeLabel = '';
      switch (n.type) {
        case 'comment_reply':
          typeLabel = 'Reply to your comment';
          break;
        case 'source_comment':
          typeLabel = 'Comment on your source';
          break;
        case 'new_revision':
          typeLabel = 'New revision';
          break;
      }
      return `<li>${typeLabel}: <a href="${workUrl}">${n.workId}/${n.sourceId}</a> (${n.revisionId.slice(0, 8)}...)</li>`;
    }).join('');

    return `
      <p>You have ${notifications.length} new notification${notifications.length > 1 ? 's' : ''}:</p>
      <ul>${lines}</ul>
      <p><a href="${notificationsUrl}">View all notifications</a></p>
    `;
  }
}
