import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnalyticsService } from '../analytics/analytics.service';
import { scannerUserHash } from './scanner.constants';

/**
 * Design section 13.4. Every Scanner log line goes through here.
 *
 * The field set below is an allow-list, and `emit` copies only these keys. That
 * is the whole point: it makes it structurally impossible to log a source
 * filename, MusicXML, image bytes, a provider secret, or a signed URL, rather
 * than relying on every call site to remember not to.
 */
export interface ScannerTelemetryFields {
  jobId?: string;
  pageNumber?: number;
  ordinal?: number;
  userHash?: string;
  workerId?: string;
  generation?: number;
  attempt?: number;
  providerAttempts?: number;
  manualRetries?: number;
  status?: string;
  previousStatus?: string;
  providerKind?: string;
  providerRevision?: string;
  modelRevision?: string;
  providerRequestId?: string;
  executionProvider?: string;
  queueWaitMs?: number;
  prepareMs?: number;
  providerMs?: number;
  inferenceMs?: number;
  renderMs?: number;
  totalMs?: number;
  inputBytes?: number;
  outputBytes?: number;
  pageWidth?: number;
  pageHeight?: number;
  pageCount?: number;
  includedPageCount?: number;
  succeededPages?: number;
  failedPages?: number;
  errorCode?: string;
  retryable?: boolean;
  leaseReclaimed?: boolean;
  cold?: boolean;
}

const ALLOWED_FIELDS: ReadonlyArray<keyof ScannerTelemetryFields> = [
  'jobId',
  'pageNumber',
  'ordinal',
  'userHash',
  'workerId',
  'generation',
  'attempt',
  'providerAttempts',
  'manualRetries',
  'status',
  'previousStatus',
  'providerKind',
  'providerRevision',
  'modelRevision',
  'providerRequestId',
  'executionProvider',
  'queueWaitMs',
  'prepareMs',
  'providerMs',
  'inferenceMs',
  'renderMs',
  'totalMs',
  'inputBytes',
  'outputBytes',
  'pageWidth',
  'pageHeight',
  'pageCount',
  'includedPageCount',
  'succeededPages',
  'failedPages',
  'errorCode',
  'retryable',
  'leaseReclaimed',
  'cold'
];

export type ScannerTelemetryEvent =
  | 'job_created'
  | 'job_claimed'
  | 'job_prepared'
  | 'job_started'
  | 'job_finished'
  | 'job_cancelled'
  | 'job_retry_queued'
  | 'page_started'
  | 'page_succeeded'
  | 'page_failed'
  | 'page_render_failed'
  | 'provider_disabled'
  | 'artifacts_purged';

@Injectable()
export class ScannerTelemetryService {
  private readonly logger = new Logger('ScannerTelemetry');

  constructor(
    private readonly config: ConfigService,
    // The worker process builds this without analytics; job-lifecycle events are
    // best-effort either way and must never fail a scan.
    @Optional() private readonly analytics?: AnalyticsService
  ) {}

  userHash(userId: string): string {
    return scannerUserHash(userId, this.config.get<string>('SCANNER_OBJECT_KEY_SALT', ''));
  }

  emit(event: ScannerTelemetryEvent, fields: ScannerTelemetryFields): void {
    const payload: Record<string, unknown> = { event };
    for (const key of ALLOWED_FIELDS) {
      const value = fields[key];
      if (value !== undefined && value !== null && value !== '') payload[key] = value;
    }
    const line = `scanner ${JSON.stringify(payload)}`;
    if (event === 'page_failed' || event === 'provider_disabled') this.logger.warn(line);
    else this.logger.log(line);
  }

  /**
   * Analytics counterparts. These must never fail a scan: `finish()` awaits
   * one, so a throw here would skip the terminal notification and push a
   * completed job down the error path.
   */
  private async track(event: Parameters<AnalyticsService['trackBestEffort']>[0]): Promise<void> {
    try {
      await this.analytics?.trackBestEffort(event);
    } catch (error) {
      this.logger.warn(
        `scanner analytics ${event.eventName} failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  async trackJobCreated(input: {
    userId: string;
    pageCount: number;
    inputContentType: string;
  }): Promise<void> {
    await this.track({
      eventName: 'scanner_job_created',
      actor: { userId: input.userId },
      requestContext: { sourceApp: 'backend', route: '/api/scanner/jobs' },
      properties: { pageCount: input.pageCount, inputContentType: input.inputContentType }
    });
  }

  async trackJobFinished(input: {
    userId: string;
    status: string;
    pageCount: number;
    succeededPages: number;
    failedPages: number;
    providerRevision?: string;
    modelRevision?: string;
    totalMs?: number;
  }): Promise<void> {
    await this.track({
      eventName: 'scanner_job_finished',
      actor: { userId: input.userId },
      requestContext: { sourceApp: 'backend' },
      properties: {
        status: input.status,
        pageCount: input.pageCount,
        succeededPages: input.succeededPages,
        failedPages: input.failedPages,
        providerRevision: input.providerRevision,
        modelRevision: input.modelRevision,
        totalMs: input.totalMs
      }
    });
  }
}
