import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import * as nodemailer from 'nodemailer';
import { TakedownCase, TakedownCaseDocument } from './schemas/takedown-case.schema';
import { TakedownNotice, TakedownNoticeDocument } from './schemas/takedown-notice.schema';
import { CounterNotice, CounterNoticeDocument } from './schemas/counter-notice.schema';
import { EnforcementAction, EnforcementActionDocument } from './schemas/enforcement-action.schema';
import { Source, SourceDocument } from '../works/schemas/source.schema';
import { SourceRevision, SourceRevisionDocument } from '../works/schemas/source-revision.schema';
import { UsersService } from '../users/users.service';
import type { RequestUser } from '../auth/types/auth-user';

type CaseStatus =
  | 'notice_received'
  | 'pending_review'
  | 'content_disabled'
  | 'counter_notice_received'
  | 'restored'
  | 'rejected'
  | 'withdrawn';

interface NoticeInput {
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
}

interface CounterNoticeInput {
  caseId: string;
  fullName: string;
  address: string;
  phone: string;
  email: string;
  statement: string;
  consentToJurisdiction: boolean;
  signature: string;
}

@Injectable()
export class LegalService {
  private readonly logger = new Logger(LegalService.name);
  private transporter: nodemailer.Transporter | null = null;
  private transporterInitialized = false;

  constructor(
    @InjectModel(TakedownCase.name)
    private readonly takedownCaseModel: Model<TakedownCaseDocument>,
    @InjectModel(TakedownNotice.name)
    private readonly takedownNoticeModel: Model<TakedownNoticeDocument>,
    @InjectModel(CounterNotice.name)
    private readonly counterNoticeModel: Model<CounterNoticeDocument>,
    @InjectModel(EnforcementAction.name)
    private readonly enforcementActionModel: Model<EnforcementActionDocument>,
    @InjectModel(Source.name)
    private readonly sourceModel: Model<SourceDocument>,
    @InjectModel(SourceRevision.name)
    private readonly sourceRevisionModel: Model<SourceRevisionDocument>,
    private readonly usersService: UsersService,
    private readonly config: ConfigService
  ) {}

  async submitNotice(
    input: NoticeInput,
    context?: { requestIp?: string; requestId?: string }
  ): Promise<{ caseId: string; status: CaseStatus }> {
    if (!input.goodFaithStatement || !input.perjuryStatement) {
      throw new BadRequestException(
        'goodFaithStatement and perjuryStatement must be accepted'
      );
    }

    const workId = input.workId?.trim();
    const sourceId = input.sourceId?.trim();
    const revisionId = input.revisionId?.trim() || undefined;
    if (!workId || !sourceId) {
      throw new BadRequestException('workId and sourceId are required');
    }

    const source = await this.sourceModel
      .findOne({ workId, sourceId })
      .lean()
      .exec();
    if (!source) {
      throw new NotFoundException('Source not found');
    }

    let revision: SourceRevisionDocument | null = null;
    if (revisionId) {
      revision = await this.sourceRevisionModel
        .findOne({ workId, sourceId, revisionId })
        .exec();
      if (!revision) {
        throw new NotFoundException('Revision not found');
      }
    }

    const caseId = `dmca_${randomUUID()}`;
    const noticeId = `ntc_${randomUUID()}`;
    const submittedAt = new Date();

    const uploaderUserId = revision
      ? (revision.createdBy && revision.createdBy !== 'system'
          ? revision.createdBy
          : source.provenance?.uploadedByUserId)
      : source.provenance?.uploadedByUserId;

    const createdCase = await this.takedownCaseModel.create({
      caseId,
      framework: 'dmca',
      status: 'notice_received',
      target: {
        workId,
        sourceId,
        revisionId,
        scope: revisionId ? 'revision' : 'source'
      },
      complainant: {
        name: input.complainantName.trim(),
        email: input.complainantEmail.trim().toLowerCase(),
        organization: input.organization?.trim() || undefined,
        address: input.address?.trim() || undefined,
        phone: input.phone?.trim() || undefined
      },
      noticeId,
      uploaderUserId: uploaderUserId || undefined,
      submittedAt,
      contentAction: { state: 'none' }
    });

    await this.takedownNoticeModel.create({
      noticeId,
      caseId,
      complainantName: input.complainantName.trim(),
      complainantEmail: input.complainantEmail.trim().toLowerCase(),
      organization: input.organization?.trim() || undefined,
      address: input.address?.trim() || undefined,
      phone: input.phone?.trim() || undefined,
      claimedWork: input.claimedWork.trim(),
      infringementStatement: input.infringementStatement.trim(),
      goodFaithStatement: input.goodFaithStatement,
      perjuryStatement: input.perjuryStatement,
      signature: input.signature.trim(),
      requestIp: context?.requestIp,
      requestId: context?.requestId,
      submittedAt
    });

    await this.recordAction(caseId, 'notice_received', undefined, {
      target: { workId, sourceId, revisionId },
      requestId: context?.requestId
    });

    await this.notifyCaseParties(createdCase, 'notice_received');

    return { caseId, status: 'notice_received' };
  }

  async submitCounterNotice(
    actor: RequestUser,
    input: CounterNoticeInput,
    context?: { requestIp?: string; requestId?: string }
  ): Promise<{ caseId: string; status: CaseStatus }> {
    const caseId = input.caseId?.trim();
    if (!caseId) throw new BadRequestException('caseId is required');

    const doc = await this.takedownCaseModel.findOne({ caseId }).exec();
    if (!doc) throw new NotFoundException('Case not found');

    const isAdmin = (actor.roles ?? []).includes('admin');
    if (!isAdmin && doc.uploaderUserId && doc.uploaderUserId !== actor.userId) {
      throw new ForbiddenException('Only uploader or admin may submit a counter notice');
    }

    if (!input.consentToJurisdiction) {
      throw new BadRequestException('consentToJurisdiction must be accepted');
    }

    const counterNoticeId = `cnt_${randomUUID()}`;
    const submittedAt = new Date();
    await this.counterNoticeModel.create({
      counterNoticeId,
      caseId,
      submittedByUserId: actor.userId,
      fullName: input.fullName.trim(),
      address: input.address.trim(),
      phone: input.phone.trim(),
      email: input.email.trim(),
      statement: input.statement.trim(),
      consentToJurisdiction: input.consentToJurisdiction,
      signature: input.signature.trim(),
      requestIp: context?.requestIp,
      requestId: context?.requestId,
      submittedAt
    });

    doc.status = 'counter_notice_received';
    doc.reviewedByUserId = actor.userId;
    doc.reviewedAt = submittedAt;
    await doc.save();

    await this.recordAction(caseId, 'counter_notice_received', actor, {
      requestId: context?.requestId
    });

    await this.notifyCaseParties(doc, 'counter_notice_received', actor);

    return { caseId, status: doc.status };
  }

  async listCases(options?: {
    status?: CaseStatus;
    limit?: number;
    offset?: number;
  }): Promise<{ items: any[]; total: number; limit: number; offset: number }> {
    const limit = Math.max(1, Math.min(options?.limit ?? 50, 200));
    const offset = Math.max(0, options?.offset ?? 0);
    const query: Record<string, unknown> = {};
    if (options?.status) query.status = options.status;

    const [total, docs] = await Promise.all([
      this.takedownCaseModel.countDocuments(query).exec(),
      this.takedownCaseModel
        .find(query)
        .sort({ submittedAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean()
        .exec()
    ]);

    return {
      items: docs,
      total,
      limit,
      offset
    };
  }

  async getCaseDetail(caseId: string): Promise<any> {
    const id = caseId.trim();
    const [doc, notices, counters, actions] = await Promise.all([
      this.takedownCaseModel.findOne({ caseId: id }).lean().exec(),
      this.takedownNoticeModel.find({ caseId: id }).sort({ submittedAt: -1 }).lean().exec(),
      this.counterNoticeModel.find({ caseId: id }).sort({ submittedAt: -1 }).lean().exec(),
      this.enforcementActionModel.find({ caseId: id }).sort({ createdAt: -1 }).lean().exec()
    ]);
    if (!doc) throw new NotFoundException('Case not found');
    return { ...doc, notices, counterNotices: counters, actions };
  }

  async setCaseStatus(
    caseId: string,
    status: CaseStatus,
    actor: RequestUser,
    reviewNote?: string
  ): Promise<{ caseId: string; status: CaseStatus }> {
    const doc = await this.takedownCaseModel.findOne({ caseId: caseId.trim() }).exec();
    if (!doc) throw new NotFoundException('Case not found');

    doc.status = status;
    doc.reviewedByUserId = actor.userId;
    doc.reviewedAt = new Date();
    doc.reviewNote = reviewNote?.trim() || undefined;
    await doc.save();

    await this.recordAction(doc.caseId, 'case_status_changed', actor, {
      status,
      reviewNote: reviewNote?.trim() || undefined
    });

    await this.notifyCaseParties(doc, 'case_status_changed', actor, {
      reviewNote: reviewNote?.trim() || undefined
    });

    return { caseId: doc.caseId, status: doc.status };
  }

  async withholdCase(
    caseId: string,
    actor: RequestUser,
    reason?: string
  ): Promise<{ caseId: string; status: CaseStatus }> {
    const doc = await this.takedownCaseModel.findOne({ caseId: caseId.trim() }).exec();
    if (!doc) throw new NotFoundException('Case not found');

    const now = new Date();
    const withheldReason = reason?.trim() || 'DMCA notice pending review';
    await this.applyVisibility(doc.target, 'withheld_dmca', {
      caseId: doc.caseId,
      reason: withheldReason,
      at: now,
      by: actor.userId
    });

    doc.status = 'content_disabled';
    doc.reviewedByUserId = actor.userId;
    doc.reviewedAt = now;
    doc.contentAction = {
      state: 'withheld',
      withheldAt: now,
      reason: withheldReason
    };
    await doc.save();

    await this.recordAction(doc.caseId, 'content_withheld', actor, {
      reason: withheldReason
    });

    await this.notifyCaseParties(doc, 'content_withheld', actor, {
      reason: withheldReason
    });

    return { caseId: doc.caseId, status: doc.status };
  }

  async restoreCase(caseId: string, actor: RequestUser): Promise<{ caseId: string; status: CaseStatus }> {
    const doc = await this.takedownCaseModel.findOne({ caseId: caseId.trim() }).exec();
    if (!doc) throw new NotFoundException('Case not found');

    const now = new Date();
    await this.applyVisibility(doc.target, 'public', {
      caseId: doc.caseId,
      at: now,
      by: actor.userId
    });

    doc.status = 'restored';
    doc.reviewedByUserId = actor.userId;
    doc.reviewedAt = now;
    doc.contentAction = {
      state: 'none',
      restoredAt: now
    };
    await doc.save();

    await this.recordAction(doc.caseId, 'content_restored', actor);
    await this.notifyCaseParties(doc, 'content_restored', actor);
    return { caseId: doc.caseId, status: doc.status };
  }

  async getComplianceMetrics(days = 90): Promise<{
    window: { from: string; to: string; days: number };
    noticesReceived: number;
    counterNoticesReceived: number;
    disabledCases: number;
    restoredCases: number;
    reinstatementRatio: number | null;
    medianTimeToDisableHours: number | null;
    medianCounterNoticeTurnaroundHours: number | null;
    casesByStatus: Record<string, number>;
  }> {
    const safeDays = Math.max(1, Math.min(days || 90, 365));
    const to = new Date();
    const from = new Date(to.getTime() - safeDays * 24 * 60 * 60 * 1000);

    const cases = await this.takedownCaseModel
      .find({ submittedAt: { $gte: from, $lte: to } })
      .select('caseId status submittedAt')
      .lean()
      .exec();
    const caseIds = cases.map((item) => item.caseId);

    const counterNoticesReceived = await this.counterNoticeModel
      .countDocuments({ submittedAt: { $gte: from, $lte: to } })
      .exec();

    const actions = caseIds.length
      ? await this.enforcementActionModel
          .find({
            caseId: { $in: caseIds },
            actionType: { $in: ['content_withheld', 'counter_notice_received', 'content_restored'] }
          })
          .select('caseId actionType createdAt')
          .sort({ createdAt: 1 })
          .lean()
          .exec()
      : [];

    const actionsByCase = new Map<
      string,
      Array<{
        actionType: 'content_withheld' | 'counter_notice_received' | 'content_restored';
        createdAt: Date;
      }>
    >();
    for (const action of actions as Array<{
      caseId: string;
      actionType: 'content_withheld' | 'counter_notice_received' | 'content_restored';
      createdAt: Date;
    }>) {
      const list = actionsByCase.get(action.caseId) ?? [];
      list.push({
        actionType: action.actionType,
        createdAt: new Date(action.createdAt)
      });
      actionsByCase.set(action.caseId, list);
    }

    const disableDurationsHours: number[] = [];
    const counterTurnaroundHours: number[] = [];
    let disabledCases = 0;
    let restoredCases = 0;
    const casesByStatus: Record<string, number> = {};

    for (const c of cases as Array<{ caseId: string; status: string; submittedAt: Date }>) {
      casesByStatus[c.status] = (casesByStatus[c.status] || 0) + 1;
      const timeline = actionsByCase.get(c.caseId) ?? [];
      const submittedAt = new Date(c.submittedAt);

      const withheld = timeline.find((a) => a.actionType === 'content_withheld');
      if (withheld) {
        disabledCases += 1;
        disableDurationsHours.push((withheld.createdAt.getTime() - submittedAt.getTime()) / 3_600_000);
      }

      const restored = timeline.find((a) => a.actionType === 'content_restored');
      if (restored) {
        restoredCases += 1;
      }

      const counterNotice = timeline.find((a) => a.actionType === 'counter_notice_received');
      if (counterNotice && restored && restored.createdAt >= counterNotice.createdAt) {
        counterTurnaroundHours.push(
          (restored.createdAt.getTime() - counterNotice.createdAt.getTime()) / 3_600_000
        );
      }
    }

    return {
      window: {
        from: from.toISOString(),
        to: to.toISOString(),
        days: safeDays
      },
      noticesReceived: cases.length,
      counterNoticesReceived,
      disabledCases,
      restoredCases,
      reinstatementRatio: disabledCases > 0 ? Number((restoredCases / disabledCases).toFixed(4)) : null,
      medianTimeToDisableHours: this.computeMedian(disableDurationsHours),
      medianCounterNoticeTurnaroundHours: this.computeMedian(counterTurnaroundHours),
      casesByStatus
    };
  }

  private async applyVisibility(
    target: {
      workId: string;
      sourceId: string;
      revisionId?: string;
      scope?: 'source' | 'revision';
    },
    visibility: 'public' | 'withheld_dmca',
    details: { caseId: string; at: Date; by?: string; reason?: string }
  ): Promise<void> {
    const withholdSet = {
      visibility,
      withheldCaseId: details.caseId,
      withheldAt: visibility === 'withheld_dmca' ? details.at : undefined,
      withheldBy: visibility === 'withheld_dmca' ? details.by : undefined,
      withheldReason: visibility === 'withheld_dmca' ? details.reason : undefined
    };

    if (target.scope === 'revision' && target.revisionId) {
      if (visibility === 'withheld_dmca') {
        await this.sourceRevisionModel
          .updateOne(
            {
              workId: target.workId,
              sourceId: target.sourceId,
              revisionId: target.revisionId
            },
            { $set: withholdSet }
          )
          .exec();
      } else {
        await this.sourceRevisionModel
          .updateOne(
            {
              workId: target.workId,
              sourceId: target.sourceId,
              revisionId: target.revisionId
            },
            {
              $set: { visibility: 'public' },
              $unset: {
                withheldCaseId: '',
                withheldAt: '',
                withheldBy: '',
                withheldReason: ''
              }
            }
          )
          .exec();
      }
      return;
    }

    if (visibility === 'withheld_dmca') {
      await this.sourceModel
        .updateOne({ workId: target.workId, sourceId: target.sourceId }, { $set: withholdSet })
        .exec();
      await this.sourceRevisionModel
        .updateMany(
          { workId: target.workId, sourceId: target.sourceId },
          { $set: withholdSet }
        )
        .exec();
      return;
    }

    await this.sourceModel
      .updateOne(
        { workId: target.workId, sourceId: target.sourceId },
        {
          $set: { visibility: 'public' },
          $unset: {
            withheldCaseId: '',
            withheldAt: '',
            withheldBy: '',
            withheldReason: ''
          }
        }
      )
      .exec();
    await this.sourceRevisionModel
      .updateMany(
        { workId: target.workId, sourceId: target.sourceId },
        {
          $set: { visibility: 'public' },
          $unset: {
            withheldCaseId: '',
            withheldAt: '',
            withheldBy: '',
            withheldReason: ''
          }
        }
      )
      .exec();
  }

  private computeMedian(values: number[]): number | null {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 1
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
    return Number(median.toFixed(2));
  }

  private getTransporter(): nodemailer.Transporter | null {
    if (this.transporterInitialized) return this.transporter;
    this.transporterInitialized = true;

    const emailServer = this.config.get<string>('EMAIL_SERVER');
    if (!emailServer) return null;

    try {
      this.transporter = nodemailer.createTransport(emailServer);
    } catch (error) {
      this.logger.warn(`Failed to configure legal email transporter: ${String((error as Error)?.message || error)}`);
      this.transporter = null;
    }
    return this.transporter;
  }

  private getEmailFrom(): string {
    return (
      this.config.get<string>('LEGAL_EMAIL_FROM') ||
      this.config.get<string>('EMAIL_FROM') ||
      'OurTextScores <noreply@example.com>'
    );
  }

  private getPublicWebBaseUrl(): string {
    const raw =
      this.config.get<string>('PUBLIC_WEB_BASE_URL') ||
      this.config.get<string>('NEXT_PUBLIC_WEB_BASE_URL') ||
      'http://localhost:3000';
    return raw.replace(/\/+$/, '');
  }

  private getLegalContactEmail(): string {
    return this.config.get<string>('DMCA_NOTICE_EMAIL') || 'dmca@ourtextscores.com';
  }

  private async notifyCaseParties(
    doc: Pick<TakedownCase, 'caseId' | 'status' | 'target' | 'complainant' | 'uploaderUserId'>,
    event:
      | 'notice_received'
      | 'counter_notice_received'
      | 'case_status_changed'
      | 'content_withheld'
      | 'content_restored',
    actor?: RequestUser,
    details?: { reason?: string; reviewNote?: string }
  ): Promise<void> {
    const recipients = new Set<string>();
    const complainantEmail = doc.complainant?.email?.trim().toLowerCase();
    if (complainantEmail) recipients.add(complainantEmail);

    if (doc.uploaderUserId) {
      try {
        const uploader = await this.usersService.findById(doc.uploaderUserId);
        const uploaderEmail = uploader?.email?.trim().toLowerCase();
        if (uploaderEmail) recipients.add(uploaderEmail);
      } catch (error) {
        this.logger.warn(
          `Could not resolve uploader email for DMCA case ${doc.caseId}: ${String((error as Error)?.message || error)}`
        );
      }
    }

    if (!recipients.size) return;

    const subjectMap: Record<string, string> = {
      notice_received: `DMCA notice received (${doc.caseId})`,
      counter_notice_received: `Counter notice received (${doc.caseId})`,
      case_status_changed: `DMCA case status updated (${doc.caseId})`,
      content_withheld: `Content withheld for DMCA case (${doc.caseId})`,
      content_restored: `Content restored for DMCA case (${doc.caseId})`
    };
    const subject = subjectMap[event] || `DMCA case update (${doc.caseId})`;

    const statusLabel = doc.status.replace(/_/g, ' ');
    const targetRevision = doc.target.revisionId ? ` / revision ${doc.target.revisionId}` : '';
    const actorLine = actor?.userId ? `\nActioned by: ${actor.userId}` : '';
    const reasonLine = details?.reason ? `\nReason: ${details.reason}` : '';
    const noteLine = details?.reviewNote ? `\nReview note: ${details.reviewNote}` : '';
    const caseUrl = `${this.getPublicWebBaseUrl()}/dmca`;
    const contactEmail = this.getLegalContactEmail();
    const text = [
      `Case: ${doc.caseId}`,
      `Status: ${statusLabel}`,
      `Target: work ${doc.target.workId} / source ${doc.target.sourceId}${targetRevision}`,
      actorLine.trim(),
      reasonLine.trim(),
      noteLine.trim(),
      '',
      `If you need to respond, contact: ${contactEmail}`,
      `DMCA policy: ${caseUrl}`
    ]
      .filter(Boolean)
      .join('\n');

    const transporter = this.getTransporter();
    if (!transporter) {
      this.logger.log(
        `DMCA notification queued without transporter case=${doc.caseId} recipients=${Array.from(recipients).join(',')}`
      );
      return;
    }

    for (const recipient of recipients) {
      try {
        await transporter.sendMail({
          from: this.getEmailFrom(),
          to: recipient,
          subject,
          text
        });
      } catch (error) {
        this.logger.warn(
          `Failed to send DMCA notification case=${doc.caseId} recipient=${recipient}: ${String((error as Error)?.message || error)}`
        );
      }
    }
  }

  private async recordAction(
    caseId: string,
    actionType:
      | 'notice_received'
      | 'counter_notice_received'
      | 'case_status_changed'
      | 'content_withheld'
      | 'content_restored',
    actor?: RequestUser,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    await this.enforcementActionModel.create({
      actionId: `act_${randomUUID()}`,
      caseId,
      actionType,
      actorUserId: actor?.userId,
      actorRole: (actor?.roles ?? []).includes('admin') ? 'admin' : 'user',
      metadata,
      createdAt: new Date()
    });
  }
}
