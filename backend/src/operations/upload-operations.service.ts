import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { UploadLimitAudit, UploadOperation } from './upload-operation.schema';
import { classifyUpload, evaluateUploadHealth, UPLOAD_OPERATIONS } from './upload-health';

@Injectable()
export class UploadOperationsService implements OnModuleInit {
  private readonly logger = new Logger(UploadOperationsService.name);
  private readonly startedAt = new Date();
  private writeFailures = 0;
  private lastWriteAt: Date | null = null;
  private lastWriteFailureAt: Date | null = null;
  constructor(
    @InjectModel(UploadOperation.name) private readonly events: Model<UploadOperation>,
    @InjectModel(UploadLimitAudit.name) private readonly audit: Model<UploadLimitAudit>
  ) {}

  async onModuleInit() {
    // These collections need their deduplication/retention indexes even when
    // the application's general MONGO_AUTO_INDEX setting is false.
    await Promise.all([this.events.createIndexes(), this.audit.createIndexes()]);
  }

  async record(input: Partial<UploadOperation>) {
    try {
      await this.events
        .updateOne(
          {
            attemptId: input.attemptId,
            observation: input.observation,
            userId: input.userId || null
          },
          { $setOnInsert: { ...input, userId: input.userId || null, at: new Date() } },
          { upsert: true }
        )
        .exec();
      this.lastWriteAt = new Date();
    } catch (error) {
      // Monitoring must not fail an otherwise valid upload. Surface degraded
      // telemetry separately; never log payloads, filenames or credentials.
      if ((error as any)?.code === 11000) return;
      this.writeFailures++;
      this.lastWriteFailureAt = new Date();
      this.logger.warn('Upload operation telemetry could not be persisted');
    }
  }

  async allowance(userId: string) {
    const latest = await this.audit
      .findOne({ userId, action: { $in: ['grant', 'revoke'] } })
      .sort({ at: -1, _id: -1 })
      .lean()
      .exec();
    return latest?.action === 'grant' && latest.expiresAt > new Date() ? latest : null;
  }

  async changeLimit(actorId: string, userId: string, body: any) {
    if (!['reset', 'grant', 'revoke'].includes(body?.action))
      throw new BadRequestException('Invalid action');
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < 5 || reason.length > 300)
      throw new BadRequestException('A reason of 5–300 characters is required');
    const entry: any = { actorId, userId, reason, action: body.action, at: new Date() };
    if (body.action === 'grant') {
      if (!Number.isInteger(body.limit) || body.limit < 60 || body.limit > 600)
        throw new BadRequestException('Hourly limit must be 60–600');
      const expiresAt = new Date(body.expiresAt);
      const ttl = expiresAt.getTime() - Date.now();
      if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 24 * 3600000)
        throw new BadRequestException('Allowance must expire within 24 hours');
      Object.assign(entry, { limit: body.limit, expiresAt });
    }
    // Write an append-only audit record before changing process-local counters.
    await this.audit.create(entry);
    return entry;
  }

  async limitsAudit() {
    return this.audit.find().sort({ at: -1, _id: -1 }).limit(30).lean().exec();
  }

  async summary(
    options: { minutes?: number; operation?: string; category?: string; role?: string } = {}
  ) {
    const minutes = options.minutes ?? 60;
    if (![15, 60, 1440, 10080].includes(minutes))
      throw new BadRequestException('Window must be 15, 60, 1440 or 10080 minutes');
    const filters: any = {};
    if (options.operation) {
      if (!(UPLOAD_OPERATIONS as readonly string[]).includes(options.operation))
        throw new BadRequestException('Invalid operation');
      filters.operation = options.operation;
    }
    if (options.category) {
      if (
        ![
          'accepted',
          'payload_too_large',
          'rate_limited',
          'authentication_or_permission',
          'server_failure',
          'invalid_request',
          'network_or_timeout'
        ].includes(options.category)
      )
        throw new BadRequestException('Invalid category');
      filters.category = options.category;
    }
    if (options.role) {
      if (!['admin', 'user', 'anonymous'].includes(options.role))
        throw new BadRequestException('Invalid account scope');
      filters.role = options.role;
    }
    const now = new Date();
    const [data] = await this.events
      .aggregate([
        { $match: { at: { $gte: new Date(now.getTime() - minutes * 60000), $lte: now } } },
        // Backend outcomes take precedence over client observations for the same
        // authenticated attempt, regardless of which report arrived first.
        { $sort: { observation: 1, at: 1 } },
        {
          $group: {
            _id: { attemptId: '$attemptId', userId: '$userId' },
            event: { $first: '$$ROOT' }
          }
        },
        { $replaceRoot: { newRoot: '$event' } },
        { $match: filters },
        {
          $facet: {
            totals: [
              {
                $group: {
                  _id: null,
                  attempts: { $sum: 1 },
                  serviceAttempts: { $sum: { $cond: [{ $in: ['$outcome', ['accepted', 'failed']] }, 1, 0] } },
                  accepted: { $sum: { $cond: [{ $eq: ['$outcome', 'accepted'] }, 1, 0] } },
                  serverFailures: {
                    $sum: { $cond: [{ $eq: ['$category', 'server_failure'] }, 1, 0] }
                  },
                  tooLarge: { $sum: { $cond: [{ $eq: ['$status', 413] }, 1, 0] } },
                  limited: { $sum: { $cond: [{ $eq: ['$status', 429] }, 1, 0] } },
                  unknown: { $sum: { $cond: [{ $eq: ['$status', 0] }, 1, 0] } },
                  clientObserved: { $sum: { $cond: [{ $eq: ['$observation', 'client'] }, 1, 0] } },
                  averageDurationMs: { $avg: '$durationMs' },
                  lastEventAt: { $max: '$at' }
                }
              }
            ],
            categories: [
              { $group: { _id: '$category', count: { $sum: 1 } } },
              { $sort: { count: -1 } }
            ],
            trend: [
              {
                $group: {
                  _id: {
                    $dateToString: {
                      date: '$at',
                      format: minutes <= 60 ? '%Y-%m-%dT%H:%M:00Z' : '%Y-%m-%dT%H:00:00Z',
                      timezone: 'UTC'
                    }
                  },
                  attempts: { $sum: 1 },
                  rejected: { $sum: { $cond: [{ $gte: ['$status', 400] }, 1, 0] } }
                }
              },
              { $sort: { _id: 1 } }
            ],
            recentFailures: [
              { $match: { outcome: { $ne: 'accepted' } } },
              { $sort: { at: -1 } },
              { $limit: 30 },
              { $project: { _id: 0 } }
            ],
            blocked: [
              { $match: { status: 429, userId: { $ne: null } } },
              { $group: { _id: '$userId' } },
              { $count: 'count' }
            ]
          }
        }
      ])
      .exec();
    const totals = {
      attempts: 0,
      serviceAttempts: 0,
      accepted: 0,
      serverFailures: 0,
      tooLarge: 0,
      limited: 0,
      unknown: 0,
      clientObserved: 0,
      averageDurationMs: null,
      lastEventAt: null,
      ...data?.totals?.[0],
      blockedAccounts: data?.blocked?.[0]?.count || 0
    };
    delete totals._id;
    const health = evaluateUploadHealth(totals);
    if (
      this.lastWriteFailureAt &&
      (!this.lastWriteAt || this.lastWriteFailureAt > this.lastWriteAt)
    ) {
      health.status = 'down';
      health.incidents.push('Upload telemetry persistence is degraded');
    }
    return {
      generatedAt: now,
      startedAt: this.startedAt,
      minutes,
      totals,
      health,
      telemetry: {
        writeFailures: this.writeFailures,
        lastWriteAt: this.lastWriteAt,
        retentionDays: 30,
        coverage:
          'Backend request outcomes and authenticated browser failure observations; acceptance does not assert asynchronous derivative completion.'
      },
      categories: data?.categories || [],
      trend: data?.trend || [],
      recentFailures: data?.recentFailures || []
    };
  }
}
