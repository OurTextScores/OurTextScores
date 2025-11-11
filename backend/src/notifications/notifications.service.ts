import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { NotificationOutbox, NotificationOutboxDocument } from './schemas/outbox.schema';
import { UsersService } from '../users/users.service';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

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

  async queueNewRevision(params: { workId: string; sourceId: string; revisionId: string; userIds: string[] }) {
    // Fan out by user preference: immediate -> new_revision; daily/weekly -> digest_item
    for (const id of params.userIds) {
      try {
        const user = await this.users.findById(id);
        const pref = user?.notify?.watchPreference || 'immediate';
        const recipient = `user:${id}`;
        if (pref === 'immediate') {
          await this.outboxModel.create({
            type: 'new_revision',
            workId: params.workId,
            sourceId: params.sourceId,
            revisionId: params.revisionId,
            recipients: [recipient],
            payload: {}
          });
        } else {
          await this.outboxModel.create({
            type: 'digest_item',
            workId: params.workId,
            sourceId: params.sourceId,
            revisionId: params.revisionId,
            recipients: [recipient],
            payload: { period: pref }
          });
        }
      } catch {
        // ignore per-user failures
      }
    }
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

  // Very simple worker: mark as sent without actually sending (scaffold)
  async processOutbox(): Promise<void> {
    // 1) Immediate notifications
    const batch = await this.outboxModel.find({ status: 'queued', type: { $in: ['push_request', 'new_revision'] } }).sort({ createdAt: 1 }).limit(10).exec();
    for (const n of batch) {
      try {
        // Resolve recipients to emails (best-effort)
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
    // 2) Digest notifications
    const now = Date.now();
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
    // Daily
    await this.sendDigestForPeriod('daily', dayAgo);
    // Weekly
    await this.sendDigestForPeriod('weekly', weekAgo);
  }

  private async sendDigestForPeriod(period: 'daily' | 'weekly', threshold: Date): Promise<void> {
    const items = await this.outboxModel.find({ status: 'queued', type: 'digest_item', 'payload.period': period, createdAt: { $lte: threshold } }).sort({ createdAt: 1 }).lean().exec();
    if (items.length === 0) return;

    // Group by recipient (expect one recipient per item)
    const byRecipient = new Map<string, typeof items>();
    for (const it of items) {
      const r = it.recipients[0] || '';
      const list = byRecipient.get(r) || [] as any;
      (list as any).push(it);
      byRecipient.set(r, list as any);
    }
    for (const [recipient, list] of byRecipient) {
      try {
        const emails: string[] = [];
        if (recipient.startsWith('user:')) {
          const id = recipient.substring('user:'.length);
          const user = await this.users.findById(id);
          if (user?.email) emails.push(user.email);
        }
        if (emails.length > 0 && this.transporter) {
          const subject = `[${period} digest] New revisions (${list.length})`;
          const lines = list.map((it) => `- ${it.workId}/${it.sourceId} (${it.revisionId})`).join('<br/>');
          const html = `<p>${list.length} new revisions you watch:</p><p>${lines}</p>`;
          await this.transporter.sendMail({ from: this.emailFrom, to: emails.join(','), subject, html });
        }
        // Mark items sent
        const ids = list.map((it) => (it as any)._id);
        await this.outboxModel.updateMany({ _id: { $in: ids } }, { $set: { status: 'sent', sentAt: new Date() }, $inc: { attempts: 1 } }).exec();
      } catch {
        // continue
      }
    }
  }

  private renderSubject(type: string, workId: string, sourceId: string, revisionId: string): string {
    switch (type) {
      case 'push_request':
        return `Approval requested for ${workId}/${sourceId} (${revisionId})`;
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
    return `
      <p>A new revision <code>${revisionId}</code> was approved.</p>
      <p>Source: <code>${workId}/${sourceId}</code></p>
      <p><a href="${workUrl}">View work</a></p>
    `;
  }
}
