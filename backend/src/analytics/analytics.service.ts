import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { Request } from 'express';
import { RequestWithId } from '../common/middleware/request-id.middleware';
import type { RequestUser } from '../auth/types/auth-user';
import {
  ANALYTICS_EVENT_NAME_SET,
  ANALYTICS_EVENT_NAMES,
  ANALYTICS_DOWNLOAD_FORMAT_SET,
  ANALYTICS_SOURCE_APP_SET,
  AnalyticsDownloadFormat,
  AnalyticsEventName,
  AnalyticsSourceApp,
  MAX_INGEST_EVENTS_PER_REQUEST,
  MAX_PROPERTIES_BYTES
} from './analytics.constants';
import { AnalyticsEvent, AnalyticsEventDocument } from './schemas/analytics-event.schema';
import {
  AnalyticsDailyRollup,
  AnalyticsDailyRollupDocument
} from './schemas/analytics-daily-rollup.schema';
import { Work, WorkDocument } from '../works/schemas/work.schema';
import { Source, SourceDocument } from '../works/schemas/source.schema';
import { SourceRevision, SourceRevisionDocument } from '../works/schemas/source-revision.schema';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_UNTRUSTED_EVENT_AGE_MS = 7 * DAY_MS;
const MAX_UNTRUSTED_EVENT_FUTURE_SKEW_MS = 5 * 60 * 1000;
const DAILY_ROLLUP_REFRESH_MS = 5 * 60 * 1000;

type Bucket = 'day' | 'week';

type RetentionWindow = 'w1' | 'w4' | 'w8';

const EDITOR_EVENTS = new Set<AnalyticsEventName>(['upload_success', 'editor_revision_saved']);
const CATALOG_EVENTS = new Set<AnalyticsEventName>([
  'catalog_search_performed',
  'score_viewed',
  'revision_commented',
  'revision_rated',
  'score_downloaded'
]);
const ENGAGEMENT_EVENTS = new Set<AnalyticsEventName>([
  ...EDITOR_EVENTS,
  ...CATALOG_EVENTS
]);

const FUNNEL_EVENT_NAMES: AnalyticsEventName[] = [
  'signup_completed',
  'first_score_loaded',
  'editor_revision_saved',
  ...Array.from(ENGAGEMENT_EVENTS)
];

const TIMESERIES_EVENT_NAMES: AnalyticsEventName[] = [
  'signup_completed',
  'upload_success',
  'editor_revision_saved',
  'catalog_search_performed',
  'score_viewed',
  'revision_commented',
  'revision_rated',
  'score_downloaded'
];

const SCORE_EDITOR_METRIC_EVENT_NAMES: AnalyticsEventName[] = [
  'score_editor_runtime_loaded',
  'score_editor_document_loaded',
  'score_editor_document_load_failed',
  'score_editor_ai_request',
  'score_editor_patch_applied',
  'score_editor_session_summary'
];

const UNTRUSTED_INGEST_ALLOWED_EVENTS = new Set<AnalyticsEventName>([
  'first_score_loaded',
  'upload_success',
  'editor_revision_saved',
  'catalog_search_performed',
  'score_viewed',
  'score_downloaded',
  'score_editor_session_started',
  'score_editor_iframe_loaded',
  'score_editor_session_ended',
  'score_editor_runtime_loaded',
  'score_editor_document_loaded',
  'score_editor_document_load_failed',
  'score_editor_ai_request',
  'score_editor_patch_applied',
  'score_editor_session_summary'
]);

interface PersistedAnalyticsEventData {
  eventName: AnalyticsEventName;
  eventTime: Date;
  sourceApp: AnalyticsSourceApp;
  userId: string | null;
  userRole: 'anonymous' | 'user' | 'admin';
  sessionId: string | null;
  requestId: string | null;
  traceId: string | null;
  route: string | null;
  properties: Record<string, unknown>;
  includeInBusinessMetrics: boolean;
}

interface IngestAnalyticsEventInput {
  eventName: string;
  properties?: unknown;
  eventTime?: string | Date;
  sourceApp?: string;
  sessionId?: string;
  requestId?: string;
  traceId?: string;
  route?: string;
}

interface ParsedIngestPayload {
  events: IngestAnalyticsEventInput[];
  sourceApp?: string;
  sessionId?: string;
  requestId?: string;
  traceId?: string;
  route?: string;
}

interface TimelineEventRecord {
  eventName: AnalyticsEventName;
  eventTime: Date;
  userId: string | null;
  properties?: Record<string, unknown>;
}

interface DailyRollupRow {
  timezone: string;
  dateKey: string;
  includeInBusinessMetrics: boolean;
  bucketStart: Date;
  wae: number;
  wacu: number;
  weu: number;
  newSignups: number;
  uploadsSuccess: number;
  revisionsSaved: number;
  searches: number;
  views: number;
  comments: number;
  ratings: number;
  downloads: number;
  downloadsByFormat: Record<string, number>;
  computedAt: Date;
}

export interface AnalyticsActorContext {
  userId?: string;
  roles?: string[];
}

export interface AnalyticsRequestContext {
  sourceApp?: AnalyticsSourceApp;
  requestId?: string;
  traceId?: string;
  sessionId?: string;
  route?: string;
}

export interface TrackAnalyticsEventInput {
  eventName: AnalyticsEventName;
  properties?: Record<string, unknown>;
  eventTime?: Date;
  actor?: AnalyticsActorContext;
  requestContext?: AnalyticsRequestContext;
}

interface IngestOptions {
  trustedIngest?: boolean;
}

export interface AnalyticsOverview {
  from: string;
  to: string;
  excludeAdmins: boolean;
  metrics: {
    wae: number;
    wacu: number;
    weu: number;
    newSignups: number;
    uploadsSuccess: number;
    revisionsSaved: number;
    commentsCreated: number;
    ratingsCreated: number;
    downloadsTotal: number;
    downloadsByFormat: Record<string, number>;
  };
}

export interface AnalyticsTimeseriesPoint {
  bucketStart: string;
  bucketLabel: string;
  wae: number;
  wacu: number;
  weu: number;
  newSignups: number;
  uploadsSuccess: number;
  revisionsSaved: number;
  searches: number;
  views: number;
  comments: number;
  ratings: number;
  downloads: number;
}

export interface AnalyticsTimeseries {
  from: string;
  to: string;
  timezone: string;
  bucket: Bucket;
  excludeAdmins: boolean;
  points: AnalyticsTimeseriesPoint[];
}

export interface AnalyticsFunnel {
  from: string;
  to: string;
  excludeAdmins: boolean;
  steps: Array<{
    key: 'signup_completed' | 'first_score_loaded' | 'first_revision_saved' | 'returned_next_week';
    count: number;
    conversionFromPrevious: number | null;
  }>;
}

export interface AnalyticsRetentionCohort {
  cohortStart: string;
  activatedUsers: number;
  retained: {
    w1: number;
    w4: number;
    w8: number;
  };
  retentionRate: {
    w1: number;
    w4: number;
    w8: number;
  };
}

export interface AnalyticsRetentionReport {
  from: string;
  to: string;
  timezone: string;
  excludeAdmins: boolean;
  cohorts: AnalyticsRetentionCohort[];
}

export interface AnalyticsCatalogStats {
  from: string;
  to: string;
  totals: {
    works: number;
    sources: number;
    revisions: number;
  };
  newInRange: {
    works: number;
    sources: number;
    revisions: number;
  };
}

export interface AnalyticsEditorMetricsPoint {
  bucketStart: string;
  bucketLabel: string;
  sessions: number;
  documentsLoaded: number;
  documentLoadFailures: number;
  aiRequests: number;
  aiFailures: number;
  patchApplyAttempts: number;
  patchApplyFailures: number;
  aiDurationAvgMs: number | null;
  aiDurationP95Ms: number | null;
}

export interface AnalyticsEditorAiBreakdownRow {
  channel: string;
  provider: string;
  model: string;
  requests: number;
  failures: number;
  failureRate: number;
  aiDurationAvgMs: number | null;
  aiDurationP95Ms: number | null;
}

export interface AnalyticsEditorMetrics {
  from: string;
  to: string;
  timezone: string;
  bucket: Bucket;
  excludeAdmins: boolean;
  summary: {
    sessions: number;
    documentsLoaded: number;
    documentLoadFailures: number;
    documentLoadFailureRate: number;
    aiRequests: number;
    aiFailures: number;
    aiFailureRate: number;
    patchApplyAttempts: number;
    patchApplyFailures: number;
    patchApplyFailureRate: number;
    aiDurationAvgMs: number | null;
    aiDurationP95Ms: number | null;
  };
  points: AnalyticsEditorMetricsPoint[];
  aiBreakdown: AnalyticsEditorAiBreakdownRow[];
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);
  private readonly verboseTrace = (process.env.ANALYTICS_TRACE_VERBOSE || '').trim().toLowerCase() === 'true';

  constructor(
    @InjectModel(AnalyticsEvent.name)
    private readonly analyticsEventModel: Model<AnalyticsEventDocument>,
    @Optional()
    @InjectModel(Work.name)
    private readonly workModel?: Model<WorkDocument>,
    @Optional()
    @InjectModel(Source.name)
    private readonly sourceModel?: Model<SourceDocument>,
    @Optional()
    @InjectModel(SourceRevision.name)
    private readonly sourceRevisionModel?: Model<SourceRevisionDocument>,
    @Optional()
    @InjectModel(AnalyticsDailyRollup.name)
    private readonly analyticsDailyRollupModel?: Model<AnalyticsDailyRollupDocument>
  ) {}

  getRequestContext(req?: Request | RequestWithId, overrides?: Partial<AnalyticsRequestContext>): AnalyticsRequestContext {
    const requestWithId = req as (RequestWithId & { traceId?: string }) | undefined;
    const header = (name: string): string | undefined => {
      const value = req?.headers?.[name];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (Array.isArray(value) && value[0]?.trim()) return value[0].trim();
      return undefined;
    };
    const cookieHeader = header('cookie');
    const cookie = (name: string): string | undefined => {
      if (!cookieHeader) {
        return undefined;
      }
      const encodedPrefix = `${encodeURIComponent(name)}=`;
      for (const segment of cookieHeader.split(';')) {
        const trimmed = segment.trim();
        if (!trimmed) {
          continue;
        }
        if (!trimmed.startsWith(encodedPrefix)) {
          continue;
        }
        const rawValue = trimmed.slice(encodedPrefix.length);
        if (!rawValue) {
          return undefined;
        }
        try {
          const decoded = decodeURIComponent(rawValue).trim();
          return decoded || undefined;
        } catch {
          return rawValue.trim() || undefined;
        }
      }
      return undefined;
    };

    return {
      sourceApp: overrides?.sourceApp ?? 'backend',
      requestId: overrides?.requestId ?? requestWithId?.requestId ?? header('x-request-id'),
      traceId:
        overrides?.traceId ??
        requestWithId?.traceId ??
        header('x-trace-id') ??
        header('traceparent'),
      sessionId:
        overrides?.sessionId ??
        header('x-session-id') ??
        header('x-client-session-id') ??
        cookie('ots_session_id'),
      route: overrides?.route ?? req?.originalUrl ?? req?.url
    };
  }

  toActor(user?: RequestUser): AnalyticsActorContext {
    if (!user?.userId) {
      return {};
    }
    return {
      userId: user.userId,
      roles: Array.isArray(user.roles) ? user.roles : []
    };
  }

  async ingest(
    body: unknown,
    actor: AnalyticsActorContext,
    reqContext: AnalyticsRequestContext,
    options?: IngestOptions
  ): Promise<{ accepted: number }> {
    const trustedIngest = options?.trustedIngest === true;
    const parsed = this.parseIngestPayload(body);
    const events = parsed.events.map((event) => {
      const mergedRequestContext: AnalyticsRequestContext = {
        sourceApp: trustedIngest
          ? (this.coerceSourceApp(event.sourceApp) ??
            this.coerceSourceApp(parsed.sourceApp) ??
            reqContext.sourceApp)
          : (reqContext.sourceApp ?? 'frontend'),
        sessionId:
          this.coerceOptionalString(event.sessionId, 'sessionId') ??
          this.coerceOptionalString(parsed.sessionId, 'sessionId') ??
          reqContext.sessionId,
        requestId: trustedIngest
          ? (this.coerceOptionalString(event.requestId, 'requestId') ??
            this.coerceOptionalString(parsed.requestId, 'requestId') ??
            reqContext.requestId)
          : reqContext.requestId,
        traceId: trustedIngest
          ? (this.coerceOptionalString(event.traceId, 'traceId') ??
            this.coerceOptionalString(parsed.traceId, 'traceId') ??
            reqContext.traceId)
          : reqContext.traceId,
        route: trustedIngest
          ? (this.coerceOptionalString(event.route, 'route') ??
            this.coerceOptionalString(parsed.route, 'route') ??
            reqContext.route)
          : reqContext.route
      };

      return this.normalizeEvent({
        eventName: event.eventName,
        properties: event.properties,
        eventTime: event.eventTime,
        actor,
        requestContext: mergedRequestContext,
        trustedIngest
      });
    });

    if (events.length > 0) {
      await this.analyticsEventModel.insertMany(events, { ordered: false });
      if (this.verboseTrace) {
        this.logger.log(
          `[analytics.ingest] accepted=${events.length} source=${reqContext.sourceApp ?? 'unknown'} events=${events
            .map((event) => event.eventName)
            .join(',')}`
        );
      }
    }

    return { accepted: events.length };
  }

  async track(event: TrackAnalyticsEventInput): Promise<void> {
    const normalized = this.normalizeEvent(event);
    await this.analyticsEventModel.create(normalized);
  }

  async trackBestEffort(event: TrackAnalyticsEventInput): Promise<void> {
    try {
      await this.track(event);
    } catch (error) {
      this.logger.warn(`Analytics track failed for ${event.eventName}: ${this.readableError(error)}`);
    }
  }

  async trackFirstScoreLoadedIfNeeded(input: {
    actor: AnalyticsActorContext;
    requestContext: AnalyticsRequestContext;
    entryType: 'existing' | 'uploaded' | 'new';
    workId?: string;
    sourceId?: string;
    revisionId?: string;
  }): Promise<boolean> {
    const userId = input.actor.userId;
    if (!userId) {
      return false;
    }

    const event = this.normalizeEvent({
      eventName: 'first_score_loaded',
      properties: {
        entry_type: input.entryType,
        ...(input.workId ? { work_id: input.workId } : {}),
        ...(input.sourceId ? { source_id: input.sourceId } : {}),
        ...(input.revisionId ? { revision_id: input.revisionId } : {})
      },
      actor: input.actor,
      requestContext: input.requestContext
    });

    try {
      await this.analyticsEventModel.create(event);
      return true;
    } catch (error: any) {
      if (error?.code === 11000) {
        return false;
      }
      throw error;
    }
  }

  async getOverview(params?: {
    from?: Date;
    to?: Date;
    excludeAdmins?: boolean;
  }): Promise<AnalyticsOverview> {
    const to = params?.to ?? new Date();
    const from = params?.from ?? new Date(to.getTime() - 7 * DAY_MS);
    const excludeAdmins = params?.excludeAdmins !== false;

    const match = this.buildMatch(from, to, excludeAdmins);

    const [counts, downloadsByFormat, wae, wacu, weu, newSignups] = await Promise.all([
      this.aggregateCountsByEvent(match),
      this.aggregateDownloadsByFormat(match),
      this.aggregateUniqueUsers(match, ['upload_success', 'editor_revision_saved']),
      this.aggregateUniqueUsers(match, [
        'catalog_search_performed',
        'score_viewed',
        'revision_commented',
        'revision_rated',
        'score_downloaded'
      ]),
      this.aggregateUniqueUsers(match, Array.from(ENGAGEMENT_EVENTS)),
      this.aggregateCountsByEvent({
        ...match,
        eventName: 'signup_completed'
      }).then((rows) => rows.signup_completed ?? 0)
    ]);

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      excludeAdmins,
      metrics: {
        wae,
        wacu,
        weu,
        newSignups,
        uploadsSuccess: counts.upload_success ?? 0,
        revisionsSaved: counts.editor_revision_saved ?? 0,
        commentsCreated: counts.revision_commented ?? 0,
        ratingsCreated: counts.revision_rated ?? 0,
        downloadsTotal: counts.score_downloaded ?? 0,
        downloadsByFormat
      }
    };
  }

  async getTimeseries(params?: {
    from?: Date;
    to?: Date;
    excludeAdmins?: boolean;
    timezone?: string;
    bucket?: Bucket;
  }): Promise<AnalyticsTimeseries> {
    const to = params?.to ?? new Date();
    const from = params?.from ?? new Date(to.getTime() - 28 * DAY_MS);
    const excludeAdmins = params?.excludeAdmins !== false;
    const timezone = this.validateTimezone(params?.timezone ?? 'America/New_York');
    const bucket = params?.bucket ?? 'day';

    if (
      bucket === 'day' &&
      excludeAdmins &&
      this.analyticsDailyRollupModel
    ) {
      return this.getTimeseriesFromRollups({ from, to, excludeAdmins, timezone, bucket });
    }

    return this.getTimeseriesFromRawEvents({ from, to, excludeAdmins, timezone, bucket });
  }

  async backfillDailyRollups(params?: {
    from?: Date;
    to?: Date;
    timezone?: string;
  }): Promise<{ timezone: string; updated: number; totalDays: number }> {
    const to = params?.to ?? new Date();
    const from = params?.from ?? new Date(to.getTime() - 28 * DAY_MS);
    const timezone = this.validateTimezone(params?.timezone ?? 'America/New_York');
    const result = await this.ensureDailyRollups({
      from,
      to,
      timezone,
      includeInBusinessMetrics: true,
      forceRefresh: true
    });
    return {
      timezone,
      updated: result.refreshed,
      totalDays: result.totalDays
    };
  }

  private async getTimeseriesFromRawEvents(params: {
    from: Date;
    to: Date;
    excludeAdmins: boolean;
    timezone: string;
    bucket: Bucket;
  }): Promise<AnalyticsTimeseries> {
    const { from, to, excludeAdmins, timezone, bucket } = params;
    const match = this.buildMatch(from, to, excludeAdmins);
    match.eventName = { $in: TIMESERIES_EVENT_NAMES };

    const bucketUnit = bucket === 'week' ? 'week' : 'day';
    const rows = await this.analyticsEventModel
      .aggregate<AnalyticsTimeseriesPoint & { bucketStart: Date }>([
        { $match: match },
        {
          $addFields: {
            bucketStart: {
              $dateTrunc: {
                date: '$eventTime',
                unit: bucketUnit,
                timezone,
                ...(bucket === 'week' ? { startOfWeek: 'monday' as const } : {})
              }
            }
          }
        },
        {
          $group: {
            _id: '$bucketStart',
            newSignups: {
              $sum: { $cond: [{ $eq: ['$eventName', 'signup_completed'] }, 1, 0] }
            },
            uploadsSuccess: {
              $sum: { $cond: [{ $eq: ['$eventName', 'upload_success'] }, 1, 0] }
            },
            revisionsSaved: {
              $sum: { $cond: [{ $eq: ['$eventName', 'editor_revision_saved'] }, 1, 0] }
            },
            searches: {
              $sum: { $cond: [{ $eq: ['$eventName', 'catalog_search_performed'] }, 1, 0] }
            },
            views: {
              $sum: { $cond: [{ $eq: ['$eventName', 'score_viewed'] }, 1, 0] }
            },
            comments: {
              $sum: { $cond: [{ $eq: ['$eventName', 'revision_commented'] }, 1, 0] }
            },
            ratings: {
              $sum: { $cond: [{ $eq: ['$eventName', 'revision_rated'] }, 1, 0] }
            },
            downloads: {
              $sum: { $cond: [{ $eq: ['$eventName', 'score_downloaded'] }, 1, 0] }
            },
            waeUsers: {
              $addToSet: {
                $cond: [
                  {
                    $and: [
                      { $in: ['$eventName', Array.from(EDITOR_EVENTS)] },
                      { $ne: ['$userId', null] }
                    ]
                  },
                  '$userId',
                  '$$REMOVE'
                ]
              }
            },
            wacuUsers: {
              $addToSet: {
                $cond: [
                  {
                    $and: [
                      { $in: ['$eventName', Array.from(CATALOG_EVENTS)] },
                      { $ne: ['$userId', null] }
                    ]
                  },
                  '$userId',
                  '$$REMOVE'
                ]
              }
            },
            weuUsers: {
              $addToSet: {
                $cond: [
                  {
                    $and: [
                      { $in: ['$eventName', Array.from(ENGAGEMENT_EVENTS)] },
                      { $ne: ['$userId', null] }
                    ]
                  },
                  '$userId',
                  '$$REMOVE'
                ]
              }
            }
          }
        },
        {
          $project: {
            _id: 0,
            bucketStart: '$_id',
            newSignups: 1,
            uploadsSuccess: 1,
            revisionsSaved: 1,
            searches: 1,
            views: 1,
            comments: 1,
            ratings: 1,
            downloads: 1,
            wae: { $size: '$waeUsers' },
            wacu: { $size: '$wacuUsers' },
            weu: { $size: '$weuUsers' }
          }
        },
        { $sort: { bucketStart: 1 } }
      ])
      .exec();

    const rowMap = new Map<string, AnalyticsTimeseriesPoint>();
    for (const row of rows) {
      const start = new Date(row.bucketStart);
      rowMap.set(this.toDateKey(start), {
        bucketStart: start.toISOString(),
        bucketLabel: this.toDateKey(start),
        wae: row.wae,
        wacu: row.wacu,
        weu: row.weu,
        newSignups: row.newSignups,
        uploadsSuccess: row.uploadsSuccess,
        revisionsSaved: row.revisionsSaved,
        searches: row.searches,
        views: row.views,
        comments: row.comments,
        ratings: row.ratings,
        downloads: row.downloads
      });
    }

    const points = this.buildDenseBucketStarts(from, to, bucket, timezone).map((start) => {
      const key = this.toDateKey(start);
      return (
        rowMap.get(key) ?? {
          bucketStart: start.toISOString(),
          bucketLabel: key,
          wae: 0,
          wacu: 0,
          weu: 0,
          newSignups: 0,
          uploadsSuccess: 0,
          revisionsSaved: 0,
          searches: 0,
          views: 0,
          comments: 0,
          ratings: 0,
          downloads: 0
        }
      );
    });

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      timezone,
      bucket,
      excludeAdmins,
      points
    };
  }

  private async getTimeseriesFromRollups(params: {
    from: Date;
    to: Date;
    excludeAdmins: boolean;
    timezone: string;
    bucket: Bucket;
  }): Promise<AnalyticsTimeseries> {
    const { from, to, excludeAdmins, timezone, bucket } = params;
    if (!this.analyticsDailyRollupModel) {
      return this.getTimeseriesFromRawEvents(params);
    }

    await this.ensureDailyRollups({
      from,
      to,
      timezone,
      includeInBusinessMetrics: true
    });

    const bucketStarts = this.buildDenseBucketStarts(from, to, 'day', timezone);
    const dateKeys = bucketStarts.map((start) => this.toDateKey(start));
    const rows = await this.analyticsDailyRollupModel
      .find(
        {
          timezone,
          includeInBusinessMetrics: true,
          dateKey: { $in: dateKeys }
        },
        {
          _id: 0,
          dateKey: 1,
          bucketStart: 1,
          wae: 1,
          wacu: 1,
          weu: 1,
          newSignups: 1,
          uploadsSuccess: 1,
          revisionsSaved: 1,
          searches: 1,
          views: 1,
          comments: 1,
          ratings: 1,
          downloads: 1
        }
      )
      .lean()
      .exec();

    const rowMap = new Map<string, DailyRollupRow>();
    for (const row of rows as unknown as DailyRollupRow[]) {
      rowMap.set(row.dateKey, row);
    }

    const points = bucketStarts.map((start) => {
      const key = this.toDateKey(start);
      const row = rowMap.get(key);
      return {
        bucketStart: start.toISOString(),
        bucketLabel: key,
        wae: row?.wae ?? 0,
        wacu: row?.wacu ?? 0,
        weu: row?.weu ?? 0,
        newSignups: row?.newSignups ?? 0,
        uploadsSuccess: row?.uploadsSuccess ?? 0,
        revisionsSaved: row?.revisionsSaved ?? 0,
        searches: row?.searches ?? 0,
        views: row?.views ?? 0,
        comments: row?.comments ?? 0,
        ratings: row?.ratings ?? 0,
        downloads: row?.downloads ?? 0
      };
    });

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      timezone,
      bucket,
      excludeAdmins,
      points
    };
  }

  async getFunnel(params?: {
    from?: Date;
    to?: Date;
    excludeAdmins?: boolean;
  }): Promise<AnalyticsFunnel> {
    const to = params?.to ?? new Date();
    const from = params?.from ?? new Date(to.getTime() - 28 * DAY_MS);
    const excludeAdmins = params?.excludeAdmins !== false;

    const events = await this.listTimelineEvents({
      from,
      to,
      excludeAdmins,
      eventNames: FUNNEL_EVENT_NAMES,
      requireUserId: true
    });

    const byUser = new Map<string, TimelineEventRecord[]>();
    for (const event of events) {
      if (!event.userId) continue;
      if (!byUser.has(event.userId)) {
        byUser.set(event.userId, []);
      }
      byUser.get(event.userId)!.push(event);
    }

    let signupCount = 0;
    let firstLoadCount = 0;
    let firstRevisionCount = 0;
    let returnedNextWeekCount = 0;

    for (const userEvents of byUser.values()) {
      userEvents.sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime());

      const signup = userEvents.find((event) => event.eventName === 'signup_completed');
      if (!signup) continue;
      signupCount += 1;

      const firstLoad = userEvents.find(
        (event) => event.eventName === 'first_score_loaded' && event.eventTime >= signup.eventTime
      );
      if (!firstLoad) continue;
      firstLoadCount += 1;

      const firstRevision = userEvents.find(
        (event) => event.eventName === 'editor_revision_saved' && event.eventTime >= firstLoad.eventTime
      );
      if (!firstRevision) continue;
      firstRevisionCount += 1;

      const start = firstRevision.eventTime.getTime() + 7 * DAY_MS;
      const end = start + 7 * DAY_MS;
      const returned = userEvents.some((event) => {
        if (!ENGAGEMENT_EVENTS.has(event.eventName)) return false;
        const ts = event.eventTime.getTime();
        return ts >= start && ts < end;
      });
      if (returned) {
        returnedNextWeekCount += 1;
      }
    }

    const steps: AnalyticsFunnel['steps'] = [
      { key: 'signup_completed', count: signupCount, conversionFromPrevious: null },
      {
        key: 'first_score_loaded',
        count: firstLoadCount,
        conversionFromPrevious: signupCount > 0 ? firstLoadCount / signupCount : 0
      },
      {
        key: 'first_revision_saved',
        count: firstRevisionCount,
        conversionFromPrevious: firstLoadCount > 0 ? firstRevisionCount / firstLoadCount : 0
      },
      {
        key: 'returned_next_week',
        count: returnedNextWeekCount,
        conversionFromPrevious: firstRevisionCount > 0 ? returnedNextWeekCount / firstRevisionCount : 0
      }
    ];

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      excludeAdmins,
      steps
    };
  }

  async getRetention(params?: {
    from?: Date;
    to?: Date;
    excludeAdmins?: boolean;
    timezone?: string;
  }): Promise<AnalyticsRetentionReport> {
    const to = params?.to ?? new Date();
    const from = params?.from ?? new Date(to.getTime() - 90 * DAY_MS);
    const excludeAdmins = params?.excludeAdmins !== false;
    const timezone = this.validateTimezone(params?.timezone ?? 'America/New_York');

    const activationMatch: Record<string, unknown> = {
      eventName: 'editor_revision_saved',
      userId: { $exists: true, $ne: null }
    };
    if (excludeAdmins) {
      activationMatch.includeInBusinessMetrics = true;
    }

    const activations = await this.analyticsEventModel
      .aggregate<{ _id: string; firstActivation: Date }>([
        { $match: activationMatch },
        { $sort: { userId: 1, eventTime: 1 } },
        { $group: { _id: '$userId', firstActivation: { $first: '$eventTime' } } },
        {
          $match: {
            firstActivation: { $gte: from, $lt: to }
          }
        }
      ])
      .exec();

    if (activations.length === 0) {
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        timezone,
        excludeAdmins,
        cohorts: []
      };
    }

    const activationByUser = new Map<string, Date>();
    let maxActivation = activations[0].firstActivation;
    for (const row of activations) {
      activationByUser.set(row._id, new Date(row.firstActivation));
      if (row.firstActivation > maxActivation) {
        maxActivation = row.firstActivation;
      }
    }

    const engagementFrom = new Date(from.getTime());
    const engagementTo = new Date(maxActivation.getTime() + 9 * 7 * DAY_MS);

    const engagementMatch = this.buildMatch(engagementFrom, engagementTo, excludeAdmins);
    engagementMatch.eventName = { $in: Array.from(ENGAGEMENT_EVENTS) };
    engagementMatch.userId = { $in: Array.from(activationByUser.keys()) };

    const engagementEvents = await this.analyticsEventModel
      .find(engagementMatch, { userId: 1, eventTime: 1, _id: 0 })
      .lean()
      .exec();

    const engagementByUser = new Map<string, number[]>();
    for (const event of engagementEvents) {
      const userId = typeof event.userId === 'string' ? event.userId : null;
      if (!userId) continue;
      if (!engagementByUser.has(userId)) {
        engagementByUser.set(userId, []);
      }
      engagementByUser.get(userId)!.push(new Date(event.eventTime).getTime());
    }

    for (const values of engagementByUser.values()) {
      values.sort((a, b) => a - b);
    }

    const cohorts = new Map<string, {
      cohortStart: Date;
      activatedUsers: number;
      retained: Record<RetentionWindow, number>;
    }>();

    for (const [userId, activationDate] of activationByUser.entries()) {
      const cohortStart = this.floorToBucket(activationDate, 'week', timezone);
      const cohortKey = this.toDateKey(cohortStart);
      if (!cohorts.has(cohortKey)) {
        cohorts.set(cohortKey, {
          cohortStart,
          activatedUsers: 0,
          retained: { w1: 0, w4: 0, w8: 0 }
        });
      }
      const cohort = cohorts.get(cohortKey)!;
      cohort.activatedUsers += 1;

      const userEngagement = engagementByUser.get(userId) ?? [];
      const checks: Record<RetentionWindow, [number, number]> = {
        w1: [activationDate.getTime() + 7 * DAY_MS, activationDate.getTime() + 14 * DAY_MS],
        w4: [activationDate.getTime() + 28 * DAY_MS, activationDate.getTime() + 35 * DAY_MS],
        w8: [activationDate.getTime() + 56 * DAY_MS, activationDate.getTime() + 63 * DAY_MS]
      };

      for (const window of ['w1', 'w4', 'w8'] as const) {
        const [start, end] = checks[window];
        const retained = userEngagement.some((timestamp) => timestamp >= start && timestamp < end);
        if (retained) {
          cohort.retained[window] += 1;
        }
      }
    }

    const cohortRows: AnalyticsRetentionCohort[] = Array.from(cohorts.values())
      .sort((a, b) => a.cohortStart.getTime() - b.cohortStart.getTime())
      .map((cohort) => ({
        cohortStart: cohort.cohortStart.toISOString(),
        activatedUsers: cohort.activatedUsers,
        retained: {
          w1: cohort.retained.w1,
          w4: cohort.retained.w4,
          w8: cohort.retained.w8
        },
        retentionRate: {
          w1: cohort.activatedUsers > 0 ? cohort.retained.w1 / cohort.activatedUsers : 0,
          w4: cohort.activatedUsers > 0 ? cohort.retained.w4 / cohort.activatedUsers : 0,
          w8: cohort.activatedUsers > 0 ? cohort.retained.w8 / cohort.activatedUsers : 0
        }
      }));

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      timezone,
      excludeAdmins,
      cohorts: cohortRows
    };
  }

  async getCatalogStats(params?: {
    from?: Date;
    to?: Date;
  }): Promise<AnalyticsCatalogStats> {
    const to = params?.to ?? new Date();
    const from = params?.from ?? new Date(to.getTime() - 28 * DAY_MS);

    if (!this.workModel || !this.sourceModel || !this.sourceRevisionModel) {
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        totals: { works: 0, sources: 0, revisions: 0 },
        newInRange: { works: 0, sources: 0, revisions: 0 }
      };
    }

    const [worksTotal, sourcesTotal, revisionsTotal, worksNew, sourcesNew, revisionsNew] = await Promise.all([
      this.workModel.countDocuments({}).exec(),
      this.sourceModel.countDocuments({}).exec(),
      this.sourceRevisionModel.countDocuments({}).exec(),
      this.workModel.countDocuments({ createdAt: { $gte: from, $lt: to } }).exec(),
      this.sourceModel.countDocuments({ createdAt: { $gte: from, $lt: to } }).exec(),
      this.sourceRevisionModel.countDocuments({ createdAt: { $gte: from, $lt: to } }).exec()
    ]);

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totals: {
        works: worksTotal,
        sources: sourcesTotal,
        revisions: revisionsTotal
      },
      newInRange: {
        works: worksNew,
        sources: sourcesNew,
        revisions: revisionsNew
      }
    };
  }

  async getScoreEditorMetrics(params?: {
    from?: Date;
    to?: Date;
    excludeAdmins?: boolean;
    timezone?: string;
    bucket?: Bucket;
  }): Promise<AnalyticsEditorMetrics> {
    const to = params?.to ?? new Date();
    const from = params?.from ?? new Date(to.getTime() - 28 * DAY_MS);
    const excludeAdmins = params?.excludeAdmins !== false;
    const timezone = this.validateTimezone(params?.timezone ?? 'America/New_York');
    const bucket = params?.bucket ?? 'day';

    const events = await this.listTimelineEvents({
      from,
      to,
      excludeAdmins,
      eventNames: SCORE_EDITOR_METRIC_EVENT_NAMES,
      includeProperties: true
    });

    type MutablePoint = {
      sessions: number;
      documentsLoaded: number;
      documentLoadFailures: number;
      aiRequests: number;
      aiFailures: number;
      patchApplyAttempts: number;
      patchApplyFailures: number;
      aiDurations: number[];
    };

    type MutableBreakdown = {
      channel: string;
      provider: string;
      model: string;
      requests: number;
      failures: number;
      durations: number[];
    };

    const pointByKey = new Map<string, MutablePoint>();
    const aiBreakdownByKey = new Map<string, MutableBreakdown>();
    const summary: MutablePoint = {
      sessions: 0,
      documentsLoaded: 0,
      documentLoadFailures: 0,
      aiRequests: 0,
      aiFailures: 0,
      patchApplyAttempts: 0,
      patchApplyFailures: 0,
      aiDurations: []
    };

    const normalizeText = (value: unknown, fallback: string, maxLength: number): string => {
      if (typeof value !== 'string') {
        return fallback;
      }
      const trimmed = value.trim();
      if (!trimmed) {
        return fallback;
      }
      return trimmed.slice(0, maxLength);
    };

    const normalizeNumber = (value: unknown): number | null => {
      const parsed =
        typeof value === 'number'
          ? value
          : typeof value === 'string'
            ? Number.parseInt(value, 10)
            : Number.NaN;
      if (!Number.isFinite(parsed)) {
        return null;
      }
      if (parsed < 0) {
        return null;
      }
      return parsed;
    };

    const normalizeOutcome = (value: unknown): 'success' | 'failure' => {
      return String(value || '').trim().toLowerCase() === 'success' ? 'success' : 'failure';
    };

    const ensurePoint = (key: string): MutablePoint => {
      const existing = pointByKey.get(key);
      if (existing) {
        return existing;
      }
      const next: MutablePoint = {
        sessions: 0,
        documentsLoaded: 0,
        documentLoadFailures: 0,
        aiRequests: 0,
        aiFailures: 0,
        patchApplyAttempts: 0,
        patchApplyFailures: 0,
        aiDurations: []
      };
      pointByKey.set(key, next);
      return next;
    };

    for (const event of events) {
      const bucketStart = this.floorToBucket(event.eventTime, bucket, timezone);
      const bucketKey = this.toDateKey(bucketStart);
      const point = ensurePoint(bucketKey);
      const properties = event.properties ?? {};

      switch (event.eventName) {
        case 'score_editor_runtime_loaded':
          summary.sessions += 1;
          point.sessions += 1;
          break;
        case 'score_editor_document_loaded':
          summary.documentsLoaded += 1;
          point.documentsLoaded += 1;
          break;
        case 'score_editor_document_load_failed':
          summary.documentLoadFailures += 1;
          point.documentLoadFailures += 1;
          break;
        case 'score_editor_ai_request': {
          summary.aiRequests += 1;
          point.aiRequests += 1;
          const outcome = normalizeOutcome(properties.outcome);
          if (outcome === 'failure') {
            summary.aiFailures += 1;
            point.aiFailures += 1;
          }

          const duration = normalizeNumber(properties.duration_ms);
          if (duration !== null) {
            summary.aiDurations.push(duration);
            point.aiDurations.push(duration);
          }

          const channel = normalizeText(properties.channel, 'unknown', 64);
          const provider = normalizeText(properties.provider ?? properties.backend, 'unknown', 64);
          const model = normalizeText(properties.model, 'unknown', 128);
          const breakdownKey = `${channel}::${provider}::${model}`;
          const breakdown = aiBreakdownByKey.get(breakdownKey) ?? {
            channel,
            provider,
            model,
            requests: 0,
            failures: 0,
            durations: []
          };
          breakdown.requests += 1;
          if (outcome === 'failure') {
            breakdown.failures += 1;
          }
          if (duration !== null) {
            breakdown.durations.push(duration);
          }
          aiBreakdownByKey.set(breakdownKey, breakdown);
          break;
        }
        case 'score_editor_patch_applied': {
          summary.patchApplyAttempts += 1;
          point.patchApplyAttempts += 1;
          const outcome = normalizeOutcome(properties.outcome);
          if (outcome === 'failure') {
            summary.patchApplyFailures += 1;
            point.patchApplyFailures += 1;
          }
          break;
        }
        default:
          break;
      }
    }

    const points = this.buildDenseBucketStarts(from, to, bucket, timezone).map((start) => {
      const key = this.toDateKey(start);
      const point = pointByKey.get(key);
      const aiDurations = point?.aiDurations ?? [];
      return {
        bucketStart: start.toISOString(),
        bucketLabel: key,
        sessions: point?.sessions ?? 0,
        documentsLoaded: point?.documentsLoaded ?? 0,
        documentLoadFailures: point?.documentLoadFailures ?? 0,
        aiRequests: point?.aiRequests ?? 0,
        aiFailures: point?.aiFailures ?? 0,
        patchApplyAttempts: point?.patchApplyAttempts ?? 0,
        patchApplyFailures: point?.patchApplyFailures ?? 0,
        aiDurationAvgMs: this.computeAverage(aiDurations),
        aiDurationP95Ms: this.computePercentile(aiDurations, 0.95)
      };
    });

    const aiBreakdown = Array.from(aiBreakdownByKey.values())
      .map((row) => ({
        channel: row.channel,
        provider: row.provider,
        model: row.model,
        requests: row.requests,
        failures: row.failures,
        failureRate: row.requests > 0 ? row.failures / row.requests : 0,
        aiDurationAvgMs: this.computeAverage(row.durations),
        aiDurationP95Ms: this.computePercentile(row.durations, 0.95)
      }))
      .sort((a, b) => {
        if (b.requests !== a.requests) return b.requests - a.requests;
        if (b.failures !== a.failures) return b.failures - a.failures;
        return a.channel.localeCompare(b.channel);
      });

    const documentLoadAttempts = summary.documentsLoaded + summary.documentLoadFailures;
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      timezone,
      bucket,
      excludeAdmins,
      summary: {
        sessions: summary.sessions,
        documentsLoaded: summary.documentsLoaded,
        documentLoadFailures: summary.documentLoadFailures,
        documentLoadFailureRate: documentLoadAttempts > 0 ? summary.documentLoadFailures / documentLoadAttempts : 0,
        aiRequests: summary.aiRequests,
        aiFailures: summary.aiFailures,
        aiFailureRate: summary.aiRequests > 0 ? summary.aiFailures / summary.aiRequests : 0,
        patchApplyAttempts: summary.patchApplyAttempts,
        patchApplyFailures: summary.patchApplyFailures,
        patchApplyFailureRate:
          summary.patchApplyAttempts > 0 ? summary.patchApplyFailures / summary.patchApplyAttempts : 0,
        aiDurationAvgMs: this.computeAverage(summary.aiDurations),
        aiDurationP95Ms: this.computePercentile(summary.aiDurations, 0.95)
      },
      points,
      aiBreakdown
    };
  }

  private async ensureDailyRollups(params: {
    from: Date;
    to: Date;
    timezone: string;
    includeInBusinessMetrics: boolean;
    forceRefresh?: boolean;
  }): Promise<{ totalDays: number; refreshed: number }> {
    if (!this.analyticsDailyRollupModel) {
      return { totalDays: 0, refreshed: 0 };
    }

    const starts = this.buildDenseBucketStarts(params.from, params.to, 'day', params.timezone);
    const dateKeys = starts.map((start) => this.toDateKey(start));
    if (dateKeys.length === 0) {
      return { totalDays: 0, refreshed: 0 };
    }

    const existingRows = await this.analyticsDailyRollupModel
      .find(
        {
          timezone: params.timezone,
          includeInBusinessMetrics: params.includeInBusinessMetrics,
          dateKey: { $in: dateKeys }
        },
        {
          _id: 0,
          dateKey: 1,
          computedAt: 1
        }
      )
      .lean()
      .exec();
    const existingByDate = new Map<string, { computedAt?: Date }>();
    for (const row of existingRows as Array<{ dateKey: string; computedAt?: Date }>) {
      existingByDate.set(row.dateKey, row);
    }

    const todayKey = this.toDateKey(this.floorToBucket(new Date(), 'day', params.timezone));
    let refreshed = 0;
    for (const dateKey of dateKeys) {
      const existing = existingByDate.get(dateKey);
      const stale =
        dateKey === todayKey &&
        existing?.computedAt instanceof Date &&
        Date.now() - existing.computedAt.getTime() > DAILY_ROLLUP_REFRESH_MS;
      if (!params.forceRefresh && existing && !stale) {
        continue;
      }

      const row = await this.computeDailyRollup({
        dateKey,
        timezone: params.timezone,
        includeInBusinessMetrics: params.includeInBusinessMetrics
      });
      await this.analyticsDailyRollupModel.updateOne(
        {
          timezone: row.timezone,
          includeInBusinessMetrics: row.includeInBusinessMetrics,
          dateKey: row.dateKey
        },
        { $set: row },
        { upsert: true }
      );
      refreshed += 1;
    }

    return {
      totalDays: dateKeys.length,
      refreshed
    };
  }

  private async computeDailyRollup(params: {
    dateKey: string;
    timezone: string;
    includeInBusinessMetrics: boolean;
  }): Promise<DailyRollupRow> {
    const { dateKey, timezone, includeInBusinessMetrics } = params;
    const bucketStart = new Date(`${dateKey}T00:00:00.000Z`);
    const roughFrom = new Date(bucketStart.getTime() - 36 * 60 * 60 * 1000);
    const roughTo = new Date(bucketStart.getTime() + 60 * 60 * 60 * 1000);

    const match: Record<string, unknown> = {
      eventTime: { $gte: roughFrom, $lt: roughTo }
    };
    if (includeInBusinessMetrics) {
      match.includeInBusinessMetrics = true;
    }

    const [countsRow, uniqueRow, downloadRows] = await Promise.all([
      this.analyticsEventModel
        .aggregate<{
          newSignups: number;
          uploadsSuccess: number;
          revisionsSaved: number;
          searches: number;
          views: number;
          comments: number;
          ratings: number;
          downloads: number;
        }>([
          { $match: match },
          {
            $addFields: {
              _bucketKey: {
                $dateToString: {
                  date: '$eventTime',
                  format: '%Y-%m-%d',
                  timezone
                }
              }
            }
          },
          { $match: { _bucketKey: dateKey } },
          {
            $group: {
              _id: null,
              newSignups: {
                $sum: { $cond: [{ $eq: ['$eventName', 'signup_completed'] }, 1, 0] }
              },
              uploadsSuccess: {
                $sum: { $cond: [{ $eq: ['$eventName', 'upload_success'] }, 1, 0] }
              },
              revisionsSaved: {
                $sum: { $cond: [{ $eq: ['$eventName', 'editor_revision_saved'] }, 1, 0] }
              },
              searches: {
                $sum: { $cond: [{ $eq: ['$eventName', 'catalog_search_performed'] }, 1, 0] }
              },
              views: {
                $sum: { $cond: [{ $eq: ['$eventName', 'score_viewed'] }, 1, 0] }
              },
              comments: {
                $sum: { $cond: [{ $eq: ['$eventName', 'revision_commented'] }, 1, 0] }
              },
              ratings: {
                $sum: { $cond: [{ $eq: ['$eventName', 'revision_rated'] }, 1, 0] }
              },
              downloads: {
                $sum: { $cond: [{ $eq: ['$eventName', 'score_downloaded'] }, 1, 0] }
              }
            }
          },
          { $project: { _id: 0 } }
        ])
        .exec()
        .then((rows) => rows[0]),
      this.analyticsEventModel
        .aggregate<{ wae: number; wacu: number; weu: number }>([
          {
            $match: {
              ...match,
              userId: { $exists: true, $ne: null }
            }
          },
          {
            $addFields: {
              _bucketKey: {
                $dateToString: {
                  date: '$eventTime',
                  format: '%Y-%m-%d',
                  timezone
                }
              }
            }
          },
          { $match: { _bucketKey: dateKey } },
          {
            $group: {
              _id: '$userId',
              wae: {
                $max: {
                  $cond: [
                    { $in: ['$eventName', Array.from(EDITOR_EVENTS)] },
                    1,
                    0
                  ]
                }
              },
              wacu: {
                $max: {
                  $cond: [
                    { $in: ['$eventName', Array.from(CATALOG_EVENTS)] },
                    1,
                    0
                  ]
                }
              },
              weu: {
                $max: {
                  $cond: [
                    { $in: ['$eventName', Array.from(ENGAGEMENT_EVENTS)] },
                    1,
                    0
                  ]
                }
              }
            }
          },
          {
            $group: {
              _id: null,
              wae: { $sum: '$wae' },
              wacu: { $sum: '$wacu' },
              weu: { $sum: '$weu' }
            }
          },
          { $project: { _id: 0 } }
        ])
        .exec()
        .then((rows) => rows[0]),
      this.analyticsEventModel
        .aggregate<{ _id: unknown; count: number }>([
          {
            $match: {
              ...match,
              eventName: 'score_downloaded'
            }
          },
          {
            $addFields: {
              _bucketKey: {
                $dateToString: {
                  date: '$eventTime',
                  format: '%Y-%m-%d',
                  timezone
                }
              }
            }
          },
          { $match: { _bucketKey: dateKey } },
          {
            $group: {
              _id: {
                $ifNull: ['$properties.file_format', 'other']
              },
              count: { $sum: 1 }
            }
          }
        ])
        .exec()
    ]);

    const downloadsByFormat: Record<string, number> = {};
    for (const row of downloadRows) {
      downloadsByFormat[String(row._id)] = row.count;
    }

    return {
      timezone,
      dateKey,
      includeInBusinessMetrics,
      bucketStart,
      wae: uniqueRow?.wae ?? 0,
      wacu: uniqueRow?.wacu ?? 0,
      weu: uniqueRow?.weu ?? 0,
      newSignups: countsRow?.newSignups ?? 0,
      uploadsSuccess: countsRow?.uploadsSuccess ?? 0,
      revisionsSaved: countsRow?.revisionsSaved ?? 0,
      searches: countsRow?.searches ?? 0,
      views: countsRow?.views ?? 0,
      comments: countsRow?.comments ?? 0,
      ratings: countsRow?.ratings ?? 0,
      downloads: countsRow?.downloads ?? 0,
      downloadsByFormat,
      computedAt: new Date()
    };
  }

  private async listTimelineEvents(params: {
    from: Date;
    to: Date;
    excludeAdmins: boolean;
    eventNames: AnalyticsEventName[];
    requireUserId?: boolean;
    includeProperties?: boolean;
  }): Promise<TimelineEventRecord[]> {
    const match = this.buildMatch(params.from, params.to, params.excludeAdmins);
    match.eventName = { $in: params.eventNames };
    if (params.requireUserId) {
      match.userId = { $exists: true, $ne: null };
    }

    const projection: Record<string, 0 | 1> = {
      eventName: 1,
      eventTime: 1,
      userId: 1,
      _id: 0
    };
    if (params.includeProperties) {
      projection.properties = 1;
    }

    const docs = await this.analyticsEventModel
      .find(match, projection)
      .lean()
      .exec();

    return docs.map((doc) => ({
      eventName: doc.eventName as AnalyticsEventName,
      eventTime: new Date(doc.eventTime),
      userId: typeof doc.userId === 'string' ? doc.userId : null,
      properties: params.includeProperties
        ?
        doc.properties && typeof doc.properties === 'object' && !Array.isArray(doc.properties)
          ? (doc.properties as Record<string, unknown>)
          : undefined
        : undefined
    }));
  }

  private buildMatch(from: Date, to: Date, excludeAdmins: boolean): Record<string, unknown> {
    const match: Record<string, unknown> = {
      eventTime: { $gte: from, $lt: to }
    };
    if (excludeAdmins) {
      match.includeInBusinessMetrics = true;
    }
    return match;
  }

  private floorToBucket(date: Date, bucket: Bucket, timezone: string): Date {
    const zoned = this.getZonedDateComponents(date, timezone);
    const localMidnightUtc = new Date(Date.UTC(zoned.year, zoned.month - 1, zoned.day));
    if (bucket === 'day') {
      return localMidnightUtc;
    }

    const dayOfWeek = localMidnightUtc.getUTCDay();
    const daysFromMonday = (dayOfWeek + 6) % 7;
    return new Date(localMidnightUtc.getTime() - daysFromMonday * DAY_MS);
  }

  private buildDenseBucketStarts(from: Date, to: Date, bucket: Bucket, timezone: string): Date[] {
    if (to <= from) {
      return [];
    }
    const starts: Date[] = [];
    const step = bucket === 'day' ? DAY_MS : 7 * DAY_MS;
    for (
      let cursor = this.floorToBucket(from, bucket, timezone);
      cursor < to;
      cursor = new Date(cursor.getTime() + step)
    ) {
      starts.push(cursor);
    }
    return starts;
  }

  private toDateKey(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  private computeAverage(values: number[]): number | null {
    if (!Array.isArray(values) || values.length === 0) {
      return null;
    }
    const sum = values.reduce((acc, value) => acc + value, 0);
    return Math.round(sum / values.length);
  }

  private computePercentile(values: number[], percentile: number): number | null {
    if (!Array.isArray(values) || values.length === 0) {
      return null;
    }
    if (!Number.isFinite(percentile)) {
      return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const normalized = Math.min(1, Math.max(0, percentile));
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(normalized * sorted.length) - 1));
    return Math.round(sorted[index]);
  }

  private getZonedDateComponents(date: Date, timezone: string): { year: number; month: number; day: number } {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const parts = formatter.formatToParts(date);
    const year = Number(parts.find((part) => part.type === 'year')?.value);
    const month = Number(parts.find((part) => part.type === 'month')?.value);
    const day = Number(parts.find((part) => part.type === 'day')?.value);

    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
      throw new BadRequestException('Unable to compute timezone bucket components');
    }

    return { year, month, day };
  }

  private validateTimezone(value: string): string {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return value;
    } catch {
      throw new BadRequestException(`Unsupported timezone "${value}"`);
    }
  }

  private async aggregateCountsByEvent(match: Record<string, unknown>): Promise<Record<string, number>> {
    const rows = await this.analyticsEventModel
      .aggregate<{ _id: string; count: number }>([
        { $match: match },
        { $group: { _id: '$eventName', count: { $sum: 1 } } }
      ])
      .exec();

    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row._id] = row.count;
    }
    return result;
  }

  private async aggregateUniqueUsers(match: Record<string, unknown>, eventNames: string[]): Promise<number> {
    const rows = await this.analyticsEventModel
      .aggregate<{ count: number }>([
        {
          $match: {
            ...match,
            eventName: { $in: eventNames },
            userId: { $exists: true, $ne: null }
          }
        },
        { $group: { _id: '$userId' } },
        { $count: 'count' }
      ])
      .exec();

    return rows[0]?.count ?? 0;
  }

  private async aggregateDownloadsByFormat(match: Record<string, unknown>): Promise<Record<string, number>> {
    const rows = await this.analyticsEventModel
      .aggregate<{ _id: string; count: number }>([
        {
          $match: {
            ...match,
            eventName: 'score_downloaded'
          }
        },
        {
          $group: {
            _id: {
              $ifNull: ['$properties.file_format', 'other']
            },
            count: { $sum: 1 }
          }
        }
      ])
      .exec();

    const result: Record<string, number> = {};
    for (const row of rows) {
      result[String(row._id)] = row.count;
    }
    return result;
  }

  private parseIngestPayload(body: unknown): ParsedIngestPayload {
    if (!body || typeof body !== 'object') {
      throw new BadRequestException('Invalid analytics payload');
    }

    const value = body as Record<string, unknown>;
    const eventsRaw = Array.isArray(value.events)
      ? value.events
      : typeof value.eventName === 'string'
        ? [value]
        : null;

    if (!eventsRaw || eventsRaw.length === 0) {
      throw new BadRequestException('Analytics payload must contain at least one event');
    }

    if (eventsRaw.length > MAX_INGEST_EVENTS_PER_REQUEST) {
      throw new BadRequestException(
        `Too many events in one request (max ${MAX_INGEST_EVENTS_PER_REQUEST})`
      );
    }

    const events = eventsRaw.map((item) => {
      if (!item || typeof item !== 'object') {
        throw new BadRequestException('Invalid analytics event item');
      }
      return item as IngestAnalyticsEventInput;
    });

    return {
      events,
      sourceApp: this.coerceOptionalString(value.sourceApp, 'sourceApp'),
      sessionId: this.coerceOptionalString(value.sessionId, 'sessionId'),
      requestId: this.coerceOptionalString(value.requestId, 'requestId'),
      traceId: this.coerceOptionalString(value.traceId, 'traceId'),
      route: this.coerceOptionalString(value.route, 'route')
    };
  }

  private normalizeEvent(input: {
    eventName: string;
    properties?: unknown;
    eventTime?: string | Date;
    actor?: AnalyticsActorContext;
    requestContext?: AnalyticsRequestContext;
    trustedIngest?: boolean;
  }): PersistedAnalyticsEventData {
    const eventName = this.coerceEventName(input.eventName);
    const isTrustedIngest = input.trustedIngest !== false;
    if (!isTrustedIngest && !UNTRUSTED_INGEST_ALLOWED_EVENTS.has(eventName)) {
      throw new BadRequestException(
        `eventName "${eventName}" is not allowed for public analytics ingest`
      );
    }
    const eventTime = this.coerceEventTime(input.eventTime, isTrustedIngest);
    const actor = input.actor ?? {};
    const userRole = this.resolveUserRole(actor);
    const sourceApp =
      this.coerceSourceApp(input.requestContext?.sourceApp) ??
      'backend';

    return {
      eventName,
      eventTime,
      sourceApp,
      userId: actor.userId ?? null,
      userRole,
      sessionId: this.coerceOptionalString(input.requestContext?.sessionId, 'sessionId') ?? null,
      requestId: this.coerceOptionalString(input.requestContext?.requestId, 'requestId') ?? null,
      traceId: this.coerceOptionalString(input.requestContext?.traceId, 'traceId') ?? null,
      route: this.coerceOptionalString(input.requestContext?.route, 'route') ?? null,
      properties: this.sanitizePropertiesForEvent(eventName, input.properties),
      includeInBusinessMetrics: userRole !== 'admin'
    };
  }

  private coerceEventName(value: string): AnalyticsEventName {
    const eventName = (value || '').trim();
    if (!eventName || !ANALYTICS_EVENT_NAME_SET.has(eventName)) {
      throw new BadRequestException(
        `Unsupported analytics eventName "${value}". Allowed: ${ANALYTICS_EVENT_NAMES.join(', ')}`
      );
    }
    return eventName as AnalyticsEventName;
  }

  private coerceEventTime(value: string | Date | undefined, trustedIngest: boolean): Date {
    if (!value) {
      return new Date();
    }
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('Invalid eventTime; expected ISO date-time string');
    }

    if (!trustedIngest) {
      const now = Date.now();
      const timestamp = date.getTime();
      if (timestamp < now - MAX_UNTRUSTED_EVENT_AGE_MS) {
        throw new BadRequestException('eventTime is too old for untrusted ingest');
      }
      if (timestamp > now + MAX_UNTRUSTED_EVENT_FUTURE_SKEW_MS) {
        throw new BadRequestException('eventTime is too far in the future for untrusted ingest');
      }
    }

    return date;
  }

  private coerceSourceApp(value: unknown): AnalyticsSourceApp | undefined {
    const sourceApp = this.coerceOptionalString(value, 'sourceApp');
    if (!sourceApp) {
      return undefined;
    }
    if (!ANALYTICS_SOURCE_APP_SET.has(sourceApp)) {
      throw new BadRequestException(
        `Unsupported sourceApp "${sourceApp}". Allowed: frontend, backend, score_editor_api`
      );
    }
    return sourceApp as AnalyticsSourceApp;
  }

  private coerceOptionalString(value: unknown, field: string): string | undefined {
    if (value == null) {
      return undefined;
    }
    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} must be a string when provided`);
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    if (trimmed.length > 256) {
      throw new BadRequestException(`${field} exceeds max length (256)`);
    }
    return trimmed;
  }

  private sanitizePropertiesObject(value: unknown): Record<string, unknown> {
    if (value == null) {
      return {};
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('properties must be an object when provided');
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw new BadRequestException('properties must be JSON-serializable');
    }

    if (serialized.length > MAX_PROPERTIES_BYTES) {
      throw new BadRequestException(
        `properties payload exceeds max size (${MAX_PROPERTIES_BYTES} bytes)`
      );
    }

    return JSON.parse(serialized) as Record<string, unknown>;
  }

  private sanitizePropertiesForEvent(eventName: AnalyticsEventName, value: unknown): Record<string, unknown> {
    const source = this.sanitizePropertiesObject(value);

    switch (eventName) {
      case 'signup_completed':
        return {
          signup_method: this.pickEnum(source.signup_method, ['email', 'google', 'github', 'other'], 'other')
        };
      case 'first_score_loaded':
        return {
          entry_type: this.pickEnum(source.entry_type, ['existing', 'uploaded', 'new'], 'existing'),
          work_id: this.pickOptionalId(source.work_id),
          source_id: this.pickOptionalId(source.source_id),
          revision_id: this.pickOptionalId(source.revision_id)
        };
      case 'upload_success':
        return {
          work_id: this.pickOptionalId(source.work_id),
          source_id: this.pickOptionalId(source.source_id),
          revision_id: this.pickOptionalId(source.revision_id),
          file_ext: this.pickOptionalString(source.file_ext, 16),
          file_size_bytes: this.pickOptionalInteger(source.file_size_bytes, 0, 250_000_000)
        };
      case 'editor_revision_saved':
        return {
          work_id: this.pickOptionalId(source.work_id),
          source_id: this.pickOptionalId(source.source_id),
          revision_id: this.pickOptionalId(source.revision_id),
          save_mode: this.pickEnum(source.save_mode, ['manual', 'autosave', 'ai_patch_apply'], 'manual')
        };
      case 'catalog_search_performed':
        return {
          query_length: this.pickOptionalInteger(source.query_length, 0, 10_000),
          result_count: this.pickOptionalInteger(source.result_count, 0, 100_000),
          search_scope: this.pickOptionalString(source.search_scope, 32) ?? 'works'
        };
      case 'score_viewed':
        return {
          work_id: this.pickOptionalId(source.work_id),
          source_id: this.pickOptionalId(source.source_id),
          revision_id: this.pickOptionalId(source.revision_id),
          view_surface: this.pickOptionalString(source.view_surface, 64) ?? 'unknown'
        };
      case 'revision_commented':
        return {
          work_id: this.pickOptionalId(source.work_id),
          source_id: this.pickOptionalId(source.source_id),
          revision_id: this.pickOptionalId(source.revision_id),
          is_reply: this.pickBoolean(source.is_reply, false)
        };
      case 'revision_rated':
        return {
          work_id: this.pickOptionalId(source.work_id),
          source_id: this.pickOptionalId(source.source_id),
          revision_id: this.pickOptionalId(source.revision_id),
          rating_value: this.pickOptionalInteger(source.rating_value, 1, 5)
        };
      case 'score_downloaded':
        return {
          work_id: this.pickOptionalId(source.work_id),
          source_id: this.pickOptionalId(source.source_id),
          revision_id: this.pickOptionalId(source.revision_id),
          file_format: this.normalizeDownloadFormat(source.file_format),
          download_surface: this.pickOptionalString(source.download_surface, 64) ?? 'api'
        };
      case 'score_editor_session_started':
        return {
          editor_surface: this.pickOptionalString(source.editor_surface, 64) ?? 'embedded',
          score_id: this.pickOptionalId(source.score_id)
        };
      case 'score_editor_iframe_loaded':
        return {
          editor_surface: this.pickOptionalString(source.editor_surface, 64) ?? 'embedded',
          load_ms: this.pickOptionalInteger(source.load_ms, 0, 300_000)
        };
      case 'score_editor_session_ended':
        return {
          editor_surface: this.pickOptionalString(source.editor_surface, 64) ?? 'embedded',
          duration_ms: this.pickOptionalInteger(source.duration_ms, 0, 86_400_000),
          close_reason: this.pickOptionalString(source.close_reason, 64)
        };
      case 'score_editor_runtime_loaded':
        return {
          editor_surface: this.pickOptionalString(source.editor_surface, 64) ?? 'embedded',
          editor_session_id: this.pickOptionalId(source.editor_session_id),
          api_request_id: this.pickOptionalId(source.api_request_id),
          api_trace_id: this.pickOptionalId(source.api_trace_id)
        };
      case 'score_editor_document_loaded':
        return {
          editor_surface: this.pickOptionalString(source.editor_surface, 64) ?? 'embedded',
          editor_session_id: this.pickOptionalId(source.editor_session_id),
          load_source: this.pickOptionalString(source.load_source, 64),
          input_format: this.pickOptionalString(source.input_format, 32),
          input_bytes: this.pickOptionalInteger(source.input_bytes, 0, 500_000_000),
          duration_ms: this.pickOptionalInteger(source.duration_ms, 0, 300_000),
          progressive_paging: this.pickBoolean(source.progressive_paging, false),
          has_more_pages: this.pickBoolean(source.has_more_pages, false),
          engine_mode: this.pickOptionalString(source.engine_mode, 64),
          api_request_id: this.pickOptionalId(source.api_request_id),
          api_trace_id: this.pickOptionalId(source.api_trace_id)
        };
      case 'score_editor_document_load_failed':
        return {
          editor_surface: this.pickOptionalString(source.editor_surface, 64) ?? 'embedded',
          editor_session_id: this.pickOptionalId(source.editor_session_id),
          load_source: this.pickOptionalString(source.load_source, 64),
          input_format: this.pickOptionalString(source.input_format, 32),
          input_bytes: this.pickOptionalInteger(source.input_bytes, 0, 500_000_000),
          duration_ms: this.pickOptionalInteger(source.duration_ms, 0, 300_000),
          engine_mode: this.pickOptionalString(source.engine_mode, 64),
          error: this.pickOptionalString(source.error, 160),
          api_request_id: this.pickOptionalId(source.api_request_id),
          api_trace_id: this.pickOptionalId(source.api_trace_id)
        };
      case 'score_editor_ai_request':
        return {
          editor_surface: this.pickOptionalString(source.editor_surface, 64) ?? 'embedded',
          editor_session_id: this.pickOptionalId(source.editor_session_id),
          channel: this.pickOptionalString(source.channel, 64),
          provider: this.pickOptionalString(source.provider, 64),
          backend: this.pickOptionalString(source.backend, 64),
          model: this.pickOptionalString(source.model, 128),
          selected_tool: this.pickOptionalString(source.selected_tool, 64),
          fallback_only: this.pickBoolean(source.fallback_only, false),
          include_xml: this.pickBoolean(source.include_xml, false),
          outcome: this.pickEnum(source.outcome, ['success', 'failure'], 'failure'),
          duration_ms: this.pickOptionalInteger(source.duration_ms, 0, 900_000),
          error: this.pickOptionalString(source.error, 160),
          space_id: this.pickOptionalString(source.space_id, 128),
          period: this.pickOptionalString(source.period, 64),
          composer: this.pickOptionalString(source.composer, 128),
          instrumentation: this.pickOptionalString(source.instrumentation, 128),
          api_request_id: this.pickOptionalId(source.api_request_id),
          api_trace_id: this.pickOptionalId(source.api_trace_id)
        };
      case 'score_editor_patch_applied':
        return {
          editor_surface: this.pickOptionalString(source.editor_surface, 64) ?? 'embedded',
          editor_session_id: this.pickOptionalId(source.editor_session_id),
          source: this.pickOptionalString(source.source, 64),
          input_format: this.pickOptionalString(source.input_format, 32),
          outcome: this.pickEnum(source.outcome, ['success', 'failure'], 'failure'),
          duration_ms: this.pickOptionalInteger(source.duration_ms, 0, 300_000),
          error: this.pickOptionalString(source.error, 160),
          api_request_id: this.pickOptionalId(source.api_request_id),
          api_trace_id: this.pickOptionalId(source.api_trace_id)
        };
      case 'score_editor_session_summary':
        return {
          editor_surface: this.pickOptionalString(source.editor_surface, 64) ?? 'embedded',
          editor_session_id: this.pickOptionalId(source.editor_session_id),
          duration_ms: this.pickOptionalInteger(source.duration_ms, 0, 86_400_000),
          documents_loaded: this.pickOptionalInteger(source.documents_loaded, 0, 10_000),
          document_load_failures: this.pickOptionalInteger(source.document_load_failures, 0, 10_000),
          ai_requests: this.pickOptionalInteger(source.ai_requests, 0, 50_000),
          ai_failures: this.pickOptionalInteger(source.ai_failures, 0, 50_000),
          patch_applies: this.pickOptionalInteger(source.patch_applies, 0, 50_000),
          patch_apply_failures: this.pickOptionalInteger(source.patch_apply_failures, 0, 50_000),
          api_request_id: this.pickOptionalId(source.api_request_id),
          api_trace_id: this.pickOptionalId(source.api_trace_id)
        };
      default:
        return source;
    }
  }

  private pickOptionalString(value: unknown, maxLength: number): string | null {
    if (value == null) {
      return null;
    }
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    return trimmed.slice(0, maxLength);
  }

  private pickOptionalId(value: unknown): string | null {
    return this.pickOptionalString(value, 128);
  }

  private pickOptionalInteger(value: unknown, min: number, max: number): number | null {
    if (value == null) {
      return null;
    }
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number.parseInt(value, 10)
          : Number.NaN;
    if (!Number.isFinite(parsed)) {
      return null;
    }
    const rounded = Math.trunc(parsed);
    if (rounded < min || rounded > max) {
      return null;
    }
    return rounded;
  }

  private pickBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
    return fallback;
  }

  private pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    if (typeof value !== 'string') {
      return fallback;
    }
    const normalized = value.trim().toLowerCase();
    if (allowed.includes(normalized as T)) {
      return normalized as T;
    }
    return fallback;
  }

  private normalizeDownloadFormat(value: unknown): AnalyticsDownloadFormat {
    const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!raw) {
      return 'other';
    }

    const withoutDot = raw.startsWith('.') ? raw.slice(1) : raw;
    const direct = withoutDot === 'xml' ? 'musicxml' : withoutDot;
    if (ANALYTICS_DOWNLOAD_FORMAT_SET.has(direct)) {
      return direct as AnalyticsDownloadFormat;
    }

    const mimeMap: Record<string, AnalyticsDownloadFormat> = {
      'application/pdf': 'pdf',
      'application/xml': 'musicxml',
      'text/xml': 'musicxml',
      'application/vnd.recordare.musicxml+xml': 'musicxml',
      'application/vnd.recordare.musicxml': 'mxl',
      'application/vnd.musescore.mscz': 'mscz',
      'audio/midi': 'midi',
      'audio/x-midi': 'midi',
      'image/png': 'png',
      'image/svg+xml': 'svg'
    };

    if (mimeMap[raw]) {
      return mimeMap[raw];
    }

    if (withoutDot === 'mid') return 'midi';
    if (withoutDot === 'musicxml') return 'musicxml';
    if (withoutDot === 'kern' || withoutDot === 'krn') return 'other';
    return 'other';
  }

  private resolveUserRole(actor: AnalyticsActorContext): 'anonymous' | 'user' | 'admin' {
    if (!actor.userId) {
      return 'anonymous';
    }
    return (actor.roles ?? []).includes('admin') ? 'admin' : 'user';
  }

  private readableError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
