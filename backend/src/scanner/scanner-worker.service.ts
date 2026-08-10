import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import AdmZip = require('adm-zip');
import sharp = require('sharp');
import { StorageService } from '../storage/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DerivativePipelineService } from '../works/derivative-pipeline.service';
import {
  ScannerEngineProvenance,
  ScannerJob,
  ScannerJobDocument,
  ScannerPageResult,
  ScannerSourceInput,
  ScannerStorageLocator
} from './schemas/scanner-job.schema';
import { ScannerAlertService } from './scanner-alert.service';
import { ScannerMergeService } from './scanner-merge.service';
import { ScannerProviderService } from './scanner-provider.service';
import { ScannerTelemetryService } from './scanner-telemetry.service';
import {
  effectivePageMusicXml,
  pageMusicXmlSuperseded,
  scannerUserHash
} from './scanner.constants';
import { isRetryableScannerErrorCode, ScannerProviderError } from './scanner.errors';
import {
  scannerEngineArtifactLocators,
  uniqueScannerStorageLocators,
  withScannerHomrRun
} from './scanner-dual-engine';
import type { ScannerPageProvider } from './scanner-provider.contract';

const execFileAsync = promisify(execFile);

/**
 * Failures that stop the worker rather than just failing one page.
 *
 * The provenance mismatches mean the provider is not the one we pinned, so
 * continuing would produce output we cannot vouch for. Budget exhaustion means
 * capacity is gone until an operator acts, so the next page cannot succeed
 * either — and recording it here is what makes it *alert*: otherwise the only
 * symptom is jobs sitting in the queue, which reports as `queue_stalled` and
 * names the wrong cause, and with no queued jobs nothing fires at all.
 *
 * Named and exported so this list is visible and testable rather than an inline
 * condition inside the page loop.
 */
export function disablesProvider(code: string): boolean {
  return (
    code === 'provider_service_revision_mismatch' ||
    code === 'provider_model_revision_mismatch' ||
    code === 'provider_execution_provider_mismatch' ||
    code === 'provider_input_digest_mismatch' ||
    code === 'provider_budget_exhausted'
  );
}
const PROCESSING_STATUSES = ['running', 'rendering'];

@Injectable()
export class ScannerWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScannerWorkerService.name);
  private readonly workerId = `${process.pid}-${randomUUID()}`;
  private timer?: NodeJS.Timeout;
  private busy = false;
  private providerDisabledReason?: string;
  private lastCleanupAt = 0;
  private lastAlertCheckAt = 0;

  constructor(
    @InjectModel(ScannerJob.name)
    private readonly jobs: Model<ScannerJobDocument>,
    private readonly storage: StorageService,
    @Inject(ScannerProviderService)
    private readonly provider: ScannerPageProvider,
    private readonly renderer: DerivativePipelineService,
    private readonly merger: ScannerMergeService,
    private readonly alerts: ScannerAlertService,
    private readonly notifications: NotificationsService,
    private readonly telemetry: ScannerTelemetryService,
    private readonly config: ConfigService
  ) {}

  onModuleInit(): void {
    if (!this.bool('SCANNER_WORKER_ENABLED', false)) return;
    this.logger.log(`Scanner worker ${this.workerId} enabled`);
    this.timer = setInterval(() => void this.tick(), 3_000);
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (Date.now() - this.lastCleanupAt > 60 * 60 * 1000) {
        await this.cleanupExpiredArtifacts();
        this.lastCleanupAt = Date.now();
      }
      const alertIntervalMs = this.number('SCANNER_ALERT_INTERVAL_MS', 60_000);
      if (Date.now() - this.lastAlertCheckAt > alertIntervalMs) {
        this.lastAlertCheckAt = Date.now();
        // Never let alerting interfere with scanning.
        await this.alerts
          .check(this.providerDisabledReason)
          .catch((error) =>
            this.logger.error(`Scanner alert check failed: ${this.message(error)}`)
          );
      }
      await this.deliverPendingTerminalNotification();
      const job = await this.claim();
      if (job) {
        this.telemetry.emit('job_claimed', {
          jobId: job.jobId,
          userHash: this.telemetry.userHash(job.userId),
          workerId: this.workerId,
          status: job.status,
          generation: job.generation,
          pageCount: job.pageCount,
          // A claim of an already-processing job means the previous lease lapsed.
          leaseReclaimed: PROCESSING_STATUSES.includes(job.status) || undefined,
          queueWaitMs: job.queuedAt ? Date.now() - job.queuedAt.getTime() : undefined
        });
      }
      if (job?.status === 'preparing') await this.prepare(job);
      else if (job) await this.process(job);
    } catch (error) {
      this.logger.error(`Scanner worker tick failed: ${this.message(error)}`);
    } finally {
      this.busy = false;
    }
  }

  private async claim(): Promise<ScannerJobDocument | null> {
    if (
      !this.bool('SCANNER_ENABLED', false) ||
      this.bool('SCANNER_PROVIDER_BUDGET_EXHAUSTED', false)
    ) {
      return null;
    }
    const now = new Date();
    const leaseExpiresAt = new Date(Date.now() + this.leaseMs());
    return this.jobs
      .findOneAndUpdate(
        {
          $or: [
            {
              status: { $in: ['preparing', 'queued'] },
              $or: [{ leaseExpiresAt: { $exists: false } }, { leaseExpiresAt: { $lt: now } }]
            },
            { status: { $in: PROCESSING_STATUSES }, leaseExpiresAt: { $lt: now } }
          ]
        },
        {
          $set: {
            leaseOwner: this.workerId,
            leaseExpiresAt,
            startedAt: now
          },
          $inc: { statusVersion: 1 }
        },
        { new: true, sort: { createdAt: 1 } }
      )
      .exec();
  }

  private async prepare(job: ScannerJobDocument): Promise<void> {
    const prepareStartedAt = Date.now();
    const workspace = await fs.mkdtemp(join(tmpdir(), 'ots-scanner-prepare-'));
    const storedLocators: ScannerStorageLocator[] = [];
    try {
      const sourceInputs = this.sourceInputs(job);
      if (sourceInputs.length === 0) {
        throw new ScannerProviderError(
          'The retained Scanner source is unavailable',
          'source_input_missing',
          false
        );
      }
      const inputs = await Promise.all(
        sourceInputs.map(async (source) => ({
          source,
          buffer: await this.storage.getObjectBuffer(
            source.storage.bucket,
            source.storage.objectKey
          )
        }))
      );
      const pageFiles = await this.preparePages(job, inputs, workspace);
      const priorResults = new Map(job.pages.map((page) => [page.pageNumber, page]));
      const pages: ScannerPageResult[] = [];
      for (const pageFile of pageFiles) {
        if (await this.isCancelled(job.jobId)) {
          await Promise.all(
            storedLocators.map((locator) =>
              this.storage.deleteObject(locator.bucket, locator.objectKey)
            )
          );
          return;
        }
        const prior = priorResults.get(pageFile.pageNumber);
        const image = await fs.readFile(pageFile.path);
        const assets = await this.ensurePageAssets(job, pageFile.pageNumber, image, prior);
        if (assets.sourceImage) storedLocators.push(assets.sourceImage);
        if (assets.thumbnail) storedLocators.push(assets.thumbnail);
        pages.push(
          withScannerHomrRun({
            pageNumber: pageFile.pageNumber,
            ordinal: prior?.ordinal || pageFile.pageNumber,
            rotationDegrees: prior?.rotationDegrees || 0,
            included: prior?.included !== false,
            status: prior?.included === false ? 'skipped' : 'pending',
            attempts: 0,
            manualRetries: 0,
            idempotencyKey: '',
            engines: prior?.engines,
            ...assets
          })
        );
      }
      const updated = await this.jobs
        .findOneAndUpdate(
          { jobId: job.jobId, status: 'preparing', leaseOwner: this.workerId },
          {
            $set: {
              status: 'ready',
              pages,
              preparedAt: new Date(),
              'timings.prepareMs': Date.now() - prepareStartedAt
            },
            $inc: { statusVersion: 1 },
            $unset: { leaseOwner: 1, leaseExpiresAt: 1 }
          },
          { new: true }
        )
        .exec();
      if (!updated) {
        await Promise.all(
          storedLocators.map((locator) =>
            this.storage.deleteObject(locator.bucket, locator.objectKey)
          )
        );
      } else {
        this.telemetry.emit('job_prepared', {
          jobId: job.jobId,
          userHash: this.telemetry.userHash(job.userId),
          workerId: this.workerId,
          status: 'ready',
          pageCount: pages.length,
          prepareMs: Date.now() - prepareStartedAt
        });
      }
    } catch (error) {
      this.logger.error(`Scanner preparation ${job.jobId} failed: ${this.message(error)}`);
      await Promise.all(
        storedLocators.map((locator) =>
          this.storage.deleteObject(locator.bucket, locator.objectKey)
        )
      );
      if (!(await this.isCancelled(job.jobId))) {
        await this.finish(job, 'failed', job.pages, {
          errorCode: 'page_preparation_failed',
          errorMessage: 'The scanner could not prepare pages from this file'
        });
      }
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }

  private async process(job: ScannerJobDocument): Promise<void> {
    const jobStartedAt = Date.now();
    const userHash = this.telemetry.userHash(job.userId);
    let providerMsTotal = 0;
    let renderMsTotal = 0;
    const workspace = await fs.mkdtemp(join(tmpdir(), 'ots-scanner-worker-'));
    try {
      if (this.providerDisabledReason) {
        throw new ScannerProviderError(this.providerDisabledReason, 'provider_disabled', false);
      }
      const pageFiles = await this.materializeConfiguredPages(job, workspace);
      const priorResults = new Map(
        job.pages.map((page) => [
          page.pageNumber,
          withScannerHomrRun(page, {
            providerRevision: job.providerRevision,
            modelRevision: job.modelRevision,
            provenance: job.engineProvenance
          })
        ])
      );
      const results: ScannerPageResult[] = job.pages
        .filter((page) => page.included === false)
        .map((page) =>
          withScannerHomrRun(
            { ...page, status: 'skipped' },
            {
              providerRevision: job.providerRevision,
              modelRevision: job.modelRevision,
              provenance: job.engineProvenance
            }
          )
        );
      const retryPageNumbers = job.retryPageNumbers?.length
        ? new Set(job.retryPageNumbers)
        : undefined;
      let providerRevision = job.providerRevision;
      let modelRevision = job.modelRevision;
      let engineProvenance = job.engineProvenance;
      let previewThumbnail: Buffer | undefined;

      const queueWaitMs = job.queuedAt ? jobStartedAt - job.queuedAt.getTime() : undefined;
      await this.updateLease(job.jobId, 'running');
      for (let index = 0; index < pageFiles.length; index += 1) {
        const pageFile = pageFiles[index];
        const pageNumber = pageFile.pageNumber;
        const detectTitle = Boolean(job.options?.detectTitle) && index === 0;
        if (await this.isCancelled(job.jobId)) return;
        const prior = priorResults.get(pageNumber);
        if (retryPageNumbers && !retryPageNumbers.has(pageNumber)) {
          if (prior) results.push(prior);
          continue;
        }
        if (prior?.status === 'succeeded' && prior.musicXml) {
          let resumed = prior;
          if (!prior.pdf) {
            try {
              await this.updateLease(job.jobId, 'rendering');
              const musicXmlBuffer = await this.storage.getObjectBuffer(
                prior.musicXml.bucket,
                prior.musicXml.objectKey
              );
              const rendered = await this.renderer.renderMusicXmlPdf(musicXmlBuffer);
              const pdf = await this.store(
                `${this.baseKey(job)}/page-${String(pageNumber).padStart(3, '0')}.pdf`,
                rendered.pdf,
                'application/pdf'
              );
              previewThumbnail ??= rendered.thumbnail;
              resumed = { ...prior, pdf };
            } catch (error) {
              this.logger.warn(
                `PDF retry failed for ${job.jobId} page ${pageNumber}: ${this.message(error)}`
              );
            }
          }
          results.push(resumed);
          continue;
        }

        const image = await fs.readFile(pageFile.path);
        const idempotencyKey = this.provider.createIdempotencyKey({
          inputSha256: createHash('sha256').update(image).digest('hex'),
          pageNumber,
          detectTitle,
          generation: job.generation
        });
        if (prior && this.shouldPreservePriorFailure(prior, idempotencyKey)) {
          results.push(prior);
          continue;
        }

        const assets = { sourceImage: prior?.sourceImage, thumbnail: prior?.thumbnail };
        const manualRetries = prior?.manualRetries || 0;
        await this.persistPageProgress(
          job,
          results,
          priorResults,
          withScannerHomrRun(
            {
              pageNumber,
              ordinal: prior?.ordinal || pageNumber,
              rotationDegrees: prior?.rotationDegrees || 0,
              included: true,
              status: 'running',
              attempts: prior?.attempts || 0,
              manualRetries,
              idempotencyKey,
              engines: prior?.engines,
              ...assets
            },
            {
              providerRevision,
              modelRevision,
              provenance: engineProvenance
            }
          ),
          providerRevision,
          modelRevision,
          engineProvenance
        );

        this.telemetry.emit('page_started', {
          jobId: job.jobId,
          userHash,
          pageNumber,
          ordinal: prior?.ordinal || pageNumber,
          generation: job.generation,
          manualRetries,
          inputBytes: image.length,
          providerKind: this.config.get<string>('SCANNER_PROVIDER_KIND', 'modal')
        });
        const pageStartedAt = Date.now();
        try {
          const scanned = await this.scanWithRetry({
            image,
            contentType: pageFile.contentType,
            pageNumber,
            generation: job.generation,
            detectTitle,
            idempotencyKey
          });
          if (await this.isCancelled(job.jobId)) return;
          providerRevision = scanned.result.providerRevision;
          modelRevision = scanned.result.modelRevision;
          engineProvenance = scanned.result.provenance;
          const musicXml = await this.store(
            `${this.baseKey(job)}/page-${String(pageNumber).padStart(3, '0')}.musicxml`,
            scanned.result.musicXml,
            'application/vnd.recordare.musicxml+xml'
          );

          const providerMs = Date.now() - pageStartedAt;
          providerMsTotal += providerMs;

          let pdf: ScannerStorageLocator | undefined;
          const renderStartedAt = Date.now();
          try {
            await this.updateLease(job.jobId, 'rendering');
            const rendered = await this.renderer.renderMusicXmlPdf(scanned.result.musicXml);
            pdf = await this.store(
              `${this.baseKey(job)}/page-${String(pageNumber).padStart(3, '0')}.pdf`,
              rendered.pdf,
              'application/pdf'
            );
            previewThumbnail ??= rendered.thumbnail;
          } catch (error) {
            this.logger.warn(
              `PDF rendering failed for ${job.jobId} page ${pageNumber}: ${this.message(error)}`
            );
            this.telemetry.emit('page_render_failed', {
              jobId: job.jobId,
              userHash,
              pageNumber,
              errorCode: 'render_failed',
              retryable: true
            });
          }
          renderMsTotal += Date.now() - renderStartedAt;
          if (await this.isCancelled(job.jobId)) {
            await this.storage.deleteObject(musicXml.bucket, musicXml.objectKey);
            if (pdf) await this.storage.deleteObject(pdf.bucket, pdf.objectKey);
            return;
          }
          results.push(
            withScannerHomrRun(
              {
                pageNumber,
                ordinal: prior?.ordinal || pageNumber,
                rotationDegrees: prior?.rotationDegrees || 0,
                included: true,
                status: 'succeeded',
                // `attempts` counts this generation, which is what the UI shows.
                // `providerAttempts` accumulates across generations and worker
                // recoveries so provenance reflects real provider calls (13.4).
                attempts: scanned.attempts,
                providerAttempts: (prior?.providerAttempts || 0) + scanned.attempts,
                manualRetries,
                idempotencyKey,
                providerRequestId: scanned.result.requestId,
                durationMs: providerMs,
                inferenceMs: scanned.result.inferenceMs,
                // Stored raw. Selection happens on read so thresholds stay tunable
                // without re-scanning (review design §4).
                review: scanned.result.review,
                engines: prior?.engines,
                ...assets,
                musicXml,
                pdf
              },
              {
                providerRevision: scanned.result.providerRevision,
                modelRevision: scanned.result.modelRevision,
                provenance: scanned.result.provenance
              }
            )
          );
          this.telemetry.emit('page_succeeded', {
            jobId: job.jobId,
            userHash,
            pageNumber,
            ordinal: prior?.ordinal || pageNumber,
            attempt: scanned.attempts,
            providerAttempts: (prior?.providerAttempts || 0) + scanned.attempts,
            providerRequestId: scanned.result.requestId,
            providerRevision: scanned.result.providerRevision,
            modelRevision: scanned.result.modelRevision,
            executionProvider: scanned.result.provenance?.executionProvider,
            providerMs,
            inferenceMs: scanned.result.inferenceMs,
            renderMs: Date.now() - renderStartedAt,
            inputBytes: image.length,
            outputBytes: scanned.result.musicXml.length
          });
        } catch (error) {
          const providerError = this.asProviderError(error);
          if (disablesProvider(providerError.code)) {
            this.providerDisabledReason = providerError.message;
            this.logger.error(`Disabling scanner provider: ${providerError.message}`);
            this.telemetry.emit('provider_disabled', {
              jobId: job.jobId,
              userHash,
              pageNumber,
              errorCode: providerError.code,
              retryable: false
            });
          }
          results.push(
            withScannerHomrRun(
              {
                pageNumber,
                ordinal: prior?.ordinal || pageNumber,
                rotationDegrees: prior?.rotationDegrees || 0,
                included: true,
                status: 'failed',
                attempts:
                  (providerError as ScannerProviderError & { attempts?: number }).attempts ?? 1,
                providerAttempts:
                  (prior?.providerAttempts || 0) +
                  ((providerError as ScannerProviderError & { attempts?: number }).attempts ?? 1),
                manualRetries,
                idempotencyKey,
                durationMs: Date.now() - pageStartedAt,
                engines: prior?.engines,
                ...assets,
                errorCode: providerError.code,
                errorMessage: providerError.message
              },
              {
                providerRevision,
                modelRevision,
                provenance: engineProvenance
              }
            )
          );
          providerMsTotal += Date.now() - pageStartedAt;
          this.telemetry.emit('page_failed', {
            jobId: job.jobId,
            userHash,
            pageNumber,
            ordinal: prior?.ordinal || pageNumber,
            attempt: (providerError as ScannerProviderError & { attempts?: number }).attempts ?? 1,
            providerMs: Date.now() - pageStartedAt,
            inputBytes: image.length,
            errorCode: providerError.code,
            retryable: providerError.retryable
          });
        }
        await this.persistPageProgress(
          job,
          results,
          priorResults,
          undefined,
          providerRevision,
          modelRevision,
          engineProvenance
        );
        await this.updateLease(job.jobId, 'running');
      }

      if (await this.isCancelled(job.jobId)) return;
      const successful = results.filter((page) => page.status === 'succeeded' && page.musicXml);
      if (successful.length === 0) {
        const firstFailure = results.find((page) => page.status === 'failed');
        await this.finish(job, 'failed', results, {
          errorCode: firstFailure?.errorCode || 'scan_failed',
          errorMessage: firstFailure?.errorMessage || 'No pages could be scanned',
          providerRevision,
          modelRevision,
          engineProvenance,
          timings: {
            queueWaitMs,
            providerMs: providerMsTotal,
            renderMs: renderMsTotal,
            totalMs: Date.now() - jobStartedAt
          }
        });
        return;
      }

      const musicXmlBundle = await this.createBundle(job, successful);
      const combined = await this.combinePages(job, successful, pageFiles.length);
      const previewPdf = await this.createPreviewPdf(job, successful, workspace);
      const previewThumbnailLocator = previewThumbnail
        ? await this.store(`${this.baseKey(job)}/preview.png`, previewThumbnail, 'image/png')
        : job.previewThumbnail;
      const status = successful.length === pageFiles.length ? 'succeeded' : 'partial';
      const resultsZip = await this.createResultsZip(job, results, {
        status,
        providerRevision,
        modelRevision,
        engineProvenance,
        combined
      });
      await this.finish(job, status, results, {
        musicXmlBundle,
        combinedMusicXml: combined.musicXml,
        combinedPdf: combined.pdf,
        mergeStatus: combined.status,
        mergeReason: combined.reason,
        resultsZip,
        previewPdf,
        previewThumbnail: previewThumbnailLocator,
        providerRevision,
        modelRevision,
        engineProvenance,
        timings: {
          queueWaitMs,
          providerMs: providerMsTotal,
          renderMs: renderMsTotal,
          totalMs: Date.now() - jobStartedAt
        },
        ...(!previewPdf
          ? {
              errorCode: 'preview_render_failed',
              errorMessage: 'MusicXML is ready, but the PDF preview could not be rendered'
            }
          : {})
      });
    } catch (error) {
      if (!(await this.isCancelled(job.jobId))) {
        this.logger.error(`Scanner job ${job.jobId} failed: ${this.message(error)}`);
        const scannerError = this.asProviderError(error);
        await this.finish(job, 'failed', job.pages, {
          errorCode: scannerError.code,
          errorMessage: scannerError.message
        });
      }
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }

  private async scanWithRetry(input: {
    image: Buffer;
    contentType?: 'image/png' | 'image/jpeg';
    pageNumber: number;
    generation?: number;
    detectTitle: boolean;
    idempotencyKey: string;
  }): Promise<{
    result: Awaited<ReturnType<ScannerPageProvider['scanPage']>>;
    attempts: number;
  }> {
    let attempt = 0;
    while (attempt < 2) {
      attempt += 1;
      if (this.bool('SCANNER_PROVIDER_BUDGET_EXHAUSTED', false)) {
        throw new ScannerProviderError(
          'Scanner monthly capacity has been reached',
          'provider_budget_exhausted',
          false
        );
      }
      try {
        const contentType = input.contentType || 'image/png';
        const result = await this.provider.scanPage({
          image: input.image,
          filename: `page-${input.pageNumber}-generation-${input.generation || 1}.${contentType === 'image/jpeg' ? 'jpg' : 'png'}`,
          contentType,
          detectTitle: input.detectTitle,
          idempotencyKey: input.idempotencyKey
        });
        return { result, attempts: attempt };
      } catch (error) {
        const scannerError = this.asProviderError(error);
        if (!scannerError.retryable || attempt >= 2) {
          (scannerError as ScannerProviderError & { attempts?: number }).attempts = attempt;
          throw scannerError;
        }
        // Design section 13.1: retry transient failures with exponential
        // backoff and jitter. Retrying instantly means the second attempt hits
        // whatever transient condition failed the first — a busy provider, a
        // cold container, a platform blip — while it is still true.
        await this.sleep(this.retryDelayMs(attempt));
      }
    }
    throw new ScannerProviderError('Scanner provider failed', 'provider_failed', false);
  }

  /** Equal jitter: half the exponential delay, plus a random half. */
  private retryDelayMs(attempt: number): number {
    const base = this.number('SCANNER_RETRY_BASE_DELAY_MS', 2_000);
    const capped = Math.min(
      base * 2 ** (attempt - 1),
      this.number('SCANNER_RETRY_MAX_DELAY_MS', 30_000)
    );
    return Math.round(capped / 2 + Math.random() * (capped / 2));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private number(key: string, fallback: number): number {
    const parsed = Number(this.config.get<string>(key, String(fallback)));
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  }

  private shouldPreservePriorFailure(
    prior: ScannerPageResult,
    currentIdempotencyKey: string
  ): boolean {
    return (
      prior.status === 'failed' &&
      (prior.idempotencyKey === currentIdempotencyKey ||
        !isRetryableScannerErrorCode(prior.errorCode))
    );
  }

  private async ensurePageAssets(
    job: ScannerJobDocument,
    pageNumber: number,
    image: Buffer,
    prior?: ScannerPageResult
  ): Promise<Pick<ScannerPageResult, 'sourceImage' | 'thumbnail'>> {
    let sourceImage = prior?.sourceImage;
    let thumbnail = prior?.thumbnail;
    const pageSegment = String(pageNumber).padStart(3, '0');
    if (!sourceImage) {
      sourceImage = await this.store(
        `${this.sourceBaseKey(job)}/page-${pageSegment}.png`,
        image,
        'image/png'
      );
    }
    if (!thumbnail) {
      const thumbnailBuffer = await sharp(image)
        .resize({ width: 320, withoutEnlargement: true })
        .png()
        .toBuffer();
      thumbnail = await this.store(
        `${this.sourceBaseKey(job)}/page-${pageSegment}-thumbnail.png`,
        thumbnailBuffer,
        'image/png'
      );
    }
    return { sourceImage, thumbnail };
  }

  private async persistPageProgress(
    job: ScannerJobDocument,
    completed: ScannerPageResult[],
    priorResults: Map<number, ScannerPageResult>,
    current: ScannerPageResult | undefined,
    providerRevision?: string,
    modelRevision?: string,
    engineProvenance?: ScannerEngineProvenance
  ): Promise<void> {
    const completedNumbers = new Set(completed.map((page) => page.pageNumber));
    if (current) completedNumbers.add(current.pageNumber);
    const remaining = Array.from({ length: job.pageCount }, (_value, index) => index + 1)
      .filter((pageNumber) => !completedNumbers.has(pageNumber))
      .map(
        (pageNumber) =>
          priorResults.get(pageNumber) || {
            pageNumber,
            ordinal: pageNumber,
            rotationDegrees: 0 as const,
            included: true,
            status: 'pending' as const,
            attempts: 0,
            manualRetries: 0,
            idempotencyKey: ''
          }
      );
    const pages = [...completed, ...(current ? [current] : []), ...remaining]
      .map((page) =>
        withScannerHomrRun(page, {
          providerRevision,
          modelRevision,
          provenance: engineProvenance
        })
      )
      .sort((left, right) => left.pageNumber - right.pageNumber);
    // Scoped to this worker's lease: a worker that stalled past its lease must
    // not overwrite the progress of whichever worker reclaimed the job.
    await this.jobs
      .updateOne(
        { jobId: job.jobId, leaseOwner: this.workerId, status: { $ne: 'cancelled' } },
        {
          $set: { pages, providerRevision, modelRevision, engineProvenance },
          $inc: { statusVersion: 1 }
        }
      )
      .exec();
  }

  private async preparePages(
    job: ScannerJobDocument,
    inputs: Array<{ source: ScannerSourceInput; buffer: Buffer }>,
    workspace: string
  ): Promise<Array<{ pageNumber: number; path: string; contentType: 'image/png' }>> {
    const isPdf = inputs[0]?.source.storage.contentType === 'application/pdf';
    if (!isPdf) {
      const pages: Array<{ pageNumber: number; path: string; contentType: 'image/png' }> = [];
      for (let index = 0; index < inputs.length; index += 1) {
        const path = join(workspace, `page-${String(index + 1).padStart(3, '0')}.png`);
        await sharp(inputs[index].buffer)
          .rotate()
          .resize({ width: 1920, withoutEnlargement: true })
          .png()
          .toFile(path);
        pages.push({ pageNumber: index + 1, path, contentType: 'image/png' });
      }
      if (pages.length !== job.pageCount) {
        throw new ScannerProviderError(
          `Expected ${job.pageCount} image pages but prepared ${pages.length}`,
          'image_preparation_failed',
          false
        );
      }
      return pages;
    }
    if (inputs.length !== 1) {
      throw new ScannerProviderError(
        'A PDF Scanner job must retain exactly one source',
        'pdf_rasterization_failed',
        false
      );
    }
    const pdfPath = join(workspace, 'source.pdf');
    const outputPrefix = join(workspace, 'page');
    await fs.writeFile(pdfPath, inputs[0].buffer);
    await execFileAsync(
      'pdftoppm',
      ['-png', '-scale-to-x', '1920', '-scale-to-y', '-1', pdfPath, outputPrefix],
      { timeout: 120_000, maxBuffer: 5 * 1024 * 1024 }
    );
    const entries = await fs.readdir(workspace);
    const pages = entries
      .filter((name) => /^page-\d+\.png$/.test(name))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
      .map((name, index) => ({
        pageNumber: index + 1,
        path: join(workspace, name),
        contentType: 'image/png' as const
      }));
    if (pages.length !== job.pageCount) {
      throw new ScannerProviderError(
        `Expected ${job.pageCount} PDF pages but rasterized ${pages.length}`,
        'pdf_rasterization_failed',
        false
      );
    }
    return pages;
  }

  private async materializeConfiguredPages(
    job: ScannerJobDocument,
    workspace: string
  ): Promise<Array<{ pageNumber: number; path: string; contentType: 'image/png' }>> {
    const configured = job.pages
      .filter((page) => page.included !== false)
      .sort(
        (left, right) => (left.ordinal || left.pageNumber) - (right.ordinal || right.pageNumber)
      );
    if (configured.length === 0) {
      throw new ScannerProviderError(
        'At least one page must be included',
        'no_pages_included',
        false
      );
    }
    const pages: Array<{ pageNumber: number; path: string; contentType: 'image/png' }> = [];
    for (const page of configured) {
      if (!page.sourceImage) {
        throw new ScannerProviderError(
          'A prepared scanner page is unavailable',
          'source_page_missing',
          false
        );
      }
      const source = await this.storage.getObjectBuffer(
        page.sourceImage.bucket,
        page.sourceImage.objectKey
      );
      const path = join(
        workspace,
        `configured-${String(page.ordinal || page.pageNumber).padStart(3, '0')}.png`
      );
      await sharp(source)
        .rotate(page.rotationDegrees || 0)
        .resize({ width: 1920, withoutEnlargement: true })
        .png()
        .toFile(path);
      pages.push({ pageNumber: page.pageNumber, path, contentType: 'image/png' });
    }
    return pages;
  }

  /**
   * Design section 6.3. Assembly is attempted only when every included page
   * succeeded, and a refusal is never fatal: the per-page MusicXML, PDFs, and
   * ZIP all stand on their own, and the job records why no combined file exists.
   */
  private async combinePages(
    job: ScannerJobDocument,
    successful: ScannerPageResult[],
    expectedPages: number
  ): Promise<{
    status: 'not-requested' | 'succeeded' | 'incompatible' | 'failed';
    reason?: string;
    musicXml?: ScannerStorageLocator;
    pdf?: ScannerStorageLocator;
  }> {
    if (!this.merger.enabled) return { status: 'not-requested' };
    if (successful.length !== expectedPages) {
      return {
        status: 'incompatible',
        reason: 'Every page must succeed before pages can be combined'
      };
    }
    if (expectedPages < 2) return { status: 'not-requested' };

    try {
      const pages = await Promise.all(
        successful.map(async (page) => {
          // A reviewed page wins over the raw recognition. Assembly is the
          // point of the review: corrections that never reached the combined
          // score would leave the reviewer's work visible only per page.
          const source = effectivePageMusicXml(page);
          return {
            ordinal: page.ordinal || page.pageNumber,
            pageNumber: page.pageNumber,
            musicXml: await this.storage.getObjectBuffer(source.bucket, source.objectKey)
          };
        })
      );
      const merged = this.merger.merge(pages);
      if (merged.status !== 'succeeded') {
        this.logger.log(`Scanner assembly declined for ${job.jobId}: ${merged.reason}`);
        return { status: merged.status, reason: merged.reason };
      }

      const musicXml = await this.store(
        `${this.baseKey(job)}/combined.musicxml`,
        merged.musicXml,
        'application/vnd.recordare.musicxml+xml'
      );
      // A render failure does not invalidate good MusicXML (section 3.5), but
      // MuseScore refusing to load the assembly is the strongest signal we have
      // that it is not musically usable, so it downgrades to 'failed'.
      let pdf: ScannerStorageLocator | undefined;
      try {
        const rendered = await this.renderer.renderMusicXmlPdf(merged.musicXml);
        pdf = await this.store(
          `${this.baseKey(job)}/combined.pdf`,
          rendered.pdf,
          'application/pdf'
        );
      } catch (error) {
        this.logger.warn(
          `Scanner combined PDF render failed for ${job.jobId}: ${this.message(error)}`
        );
        // The combined MusicXML is not offered, so do not leave it behind.
        await this.storage.deleteObject(musicXml.bucket, musicXml.objectKey);
        return {
          status: 'failed',
          reason: 'The combined score could not be rendered, so it is not offered'
        };
      }
      return { status: 'succeeded', musicXml, pdf };
    } catch (error) {
      this.logger.warn(`Scanner assembly failed for ${job.jobId}: ${this.message(error)}`);
      return { status: 'failed', reason: 'Pages could not be combined' };
    }
  }

  private async createBundle(
    job: ScannerJobDocument,
    pages: ScannerPageResult[]
  ): Promise<ScannerStorageLocator> {
    const onlyPage = effectivePageMusicXml(pages[0]);
    if (job.pageCount === 1 && onlyPage) return onlyPage;
    const zip = new AdmZip();
    for (const page of pages) {
      const pageMusicXml = effectivePageMusicXml(page);
      if (!pageMusicXml) continue;
      const contents = await this.storage.getObjectBuffer(
        pageMusicXml.bucket,
        pageMusicXml.objectKey
      );
      zip.addFile(
        `page-${String(page.ordinal || page.pageNumber).padStart(3, '0')}.musicxml`,
        contents
      );
    }
    return this.store(`${this.baseKey(job)}/musicxml-pages.zip`, zip.toBuffer(), 'application/zip');
  }

  private async createPreviewPdf(
    job: ScannerJobDocument,
    pages: ScannerPageResult[],
    workspace: string
  ): Promise<ScannerStorageLocator | undefined> {
    const pdfPages = pages.filter((page) => page.pdf && !pageMusicXmlSuperseded(page));
    if (pdfPages.length === 0) return undefined;
    if (pdfPages.length === 1 && pdfPages[0].pdf) return pdfPages[0].pdf;
    const paths: string[] = [];
    for (const page of pdfPages) {
      const path = join(
        workspace,
        `rendered-${String(page.ordinal || page.pageNumber).padStart(3, '0')}.pdf`
      );
      const locator = page.pdf!;
      await fs.writeFile(
        path,
        await this.storage.getObjectBuffer(locator.bucket, locator.objectKey)
      );
      paths.push(path);
    }
    const combined = join(workspace, 'preview.pdf');
    try {
      await execFileAsync('pdfunite', [...paths, combined], { timeout: 60_000 });
      return this.store(
        `${this.baseKey(job)}/preview.pdf`,
        await fs.readFile(combined),
        'application/pdf'
      );
    } catch (error) {
      this.logger.warn(`Unable to combine scanner preview PDF: ${this.message(error)}`);
      return pdfPages[0].pdf;
    }
  }

  private async createResultsZip(
    job: ScannerJobDocument,
    pages: ScannerPageResult[],
    summary: {
      status: 'succeeded' | 'partial';
      providerRevision?: string;
      modelRevision?: string;
      engineProvenance?: ScannerEngineProvenance;
      combined?: {
        status: 'not-requested' | 'succeeded' | 'incompatible' | 'failed';
        reason?: string;
        musicXml?: ScannerStorageLocator;
        pdf?: ScannerStorageLocator;
      };
    }
  ): Promise<ScannerStorageLocator> {
    const zip = new AdmZip();
    for (const page of pages) {
      const pageSegment = String(page.ordinal || page.pageNumber).padStart(3, '0');
      const pageMusicXml = effectivePageMusicXml(page);
      if (pageMusicXml) {
        zip.addFile(
          `page-${pageSegment}.musicxml`,
          await this.storage.getObjectBuffer(pageMusicXml.bucket, pageMusicXml.objectKey)
        );
      }
      if (page.pdf && !pageMusicXmlSuperseded(page)) {
        zip.addFile(
          `page-${pageSegment}.pdf`,
          await this.storage.getObjectBuffer(page.pdf.bucket, page.pdf.objectKey)
        );
      }
    }
    for (const [name, locator] of [
      ['combined.musicxml', summary.combined?.musicXml],
      ['combined.pdf', summary.combined?.pdf]
    ] as const) {
      if (locator) {
        zip.addFile(name, await this.storage.getObjectBuffer(locator.bucket, locator.objectKey));
      }
    }
    const manifest = {
      version: 1,
      jobId: job.jobId,
      status: summary.status,
      mergeStatus: summary.combined?.status ?? 'not-requested',
      mergeReason: summary.combined?.reason,
      engine: 'homr',
      serviceRevision: summary.providerRevision,
      modelRevision: summary.modelRevision,
      // Design section 7.1/17: the weights are versioned separately from the
      // HOMR commit, so a result is only reproducible with both recorded.
      engineProvenance: summary.engineProvenance,
      createdAt: new Date().toISOString(),
      pages: pages.map((page) => ({
        pageNumber: page.pageNumber,
        ordinal: page.ordinal || page.pageNumber,
        rotationDegrees: page.rotationDegrees || 0,
        included: page.included !== false,
        status: page.status,
        attempts: page.attempts,
        providerAttempts: page.providerAttempts ?? page.attempts,
        providerRequestId: page.providerRequestId,
        manualRetries: page.manualRetries || 0,
        errorCode: page.errorCode,
        errorMessage: page.errorMessage,
        musicXmlSha256: effectivePageMusicXml(page)?.checksumSha256,
        pdfSha256: pageMusicXmlSuperseded(page) ? undefined : page.pdf?.checksumSha256
      }))
    };
    zip.addFile('scanner-manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
    zip.addFile('README.txt', Buffer.from(this.readmeText(summary.combined)));
    return this.store(`${this.baseKey(job)}/results.zip`, zip.toBuffer(), 'application/zip');
  }

  private readmeText(combined?: {
    status: 'not-requested' | 'succeeded' | 'incompatible' | 'failed';
    reason?: string;
  }): string {
    const header =
      'OurTextScores Scanner results\n\nEach page is transcribed independently. Review all MusicXML before use.\n\n';
    if (combined?.status === 'succeeded') {
      return `${header}combined.musicxml joins every page into one score. Page assembly is a beta convenience: measure numbering is made continuous and page breaks are preserved, but ties, slurs, and lyrics that cross a page boundary are NOT reconstructed. The per-page files remain authoritative.\n`;
    }
    if (combined?.status === 'incompatible' || combined?.status === 'failed') {
      return `${header}The pages were not combined: ${combined.reason ?? 'they are not compatible'}. The per-page files below are complete and unaffected.\n`;
    }
    return `${header}Multi-page MusicXML assembly is not enabled, so page files are intentionally kept separate.\n`;
  }

  private async finish(
    job: ScannerJobDocument,
    status: 'succeeded' | 'partial' | 'failed',
    pages: ScannerPageResult[],
    values: Record<string, any>
  ): Promise<void> {
    const completedAt = new Date();
    // Lease-scoped for the same reason as persistPageProgress: only the worker
    // that currently holds the job may terminalise it.
    const updated = await this.jobs
      .findOneAndUpdate(
        { jobId: job.jobId, leaseOwner: this.workerId, status: { $ne: 'cancelled' } },
        {
          $set: {
            status,
            pages,
            completedAt,
            leaseExpiresAt: null,
            leaseOwner: null,
            ...values
          },
          $inc: { statusVersion: 1 },
          $unset: { retryPageNumbers: 1 }
        },
        { new: true }
      )
      .exec();
    if (!updated) return;
    const succeededPages = pages.filter((page) => page.status === 'succeeded').length;
    const failedPages = pages.filter((page) => page.status === 'failed').length;
    this.telemetry.emit('job_finished', {
      jobId: job.jobId,
      userHash: this.telemetry.userHash(job.userId),
      workerId: this.workerId,
      status,
      generation: job.generation,
      pageCount: job.pageCount,
      includedPageCount: pages.filter((page) => page.included !== false).length,
      succeededPages,
      failedPages,
      providerRevision: values.providerRevision,
      modelRevision: values.modelRevision,
      queueWaitMs: values.timings?.queueWaitMs,
      providerMs: values.timings?.providerMs,
      renderMs: values.timings?.renderMs,
      totalMs: values.timings?.totalMs,
      errorCode: values.errorCode
    });
    await this.telemetry.trackJobFinished({
      userId: job.userId,
      status,
      pageCount: job.pageCount,
      succeededPages,
      failedPages,
      providerRevision: values.providerRevision,
      modelRevision: values.modelRevision,
      totalMs: values.timings?.totalMs
    });
    await this.notifyTerminal(updated);
  }

  private async deliverPendingTerminalNotification(): Promise<void> {
    if (!this.bool('SCANNER_TERMINAL_NOTIFICATIONS_ENABLED', true)) return;
    const pending = await this.jobs
      .findOne({
        status: { $in: ['succeeded', 'partial', 'failed'] },
        terminalNotifiedAt: { $exists: false }
      })
      .sort({ completedAt: 1 })
      .exec();
    if (pending) await this.notifyTerminal(pending);
  }

  private async notifyTerminal(job: ScannerJobDocument): Promise<void> {
    if (
      !this.bool('SCANNER_TERMINAL_NOTIFICATIONS_ENABLED', true) ||
      !['succeeded', 'partial', 'failed'].includes(job.status)
    ) {
      return;
    }
    try {
      await this.notifications.queueScannerTerminal({
        jobId: job.jobId,
        generation: job.generation,
        recipientUserId: job.userId,
        status: job.status as 'succeeded' | 'partial' | 'failed',
        originalFilename: job.originalFilename,
        succeededPages: job.pages.filter((page) => page.status === 'succeeded').length,
        pageCount: job.pages.filter((page) => page.included !== false).length
      });
      await this.jobs
        .updateOne(
          { _id: job._id, terminalNotifiedAt: { $exists: false } },
          { $set: { terminalNotifiedAt: new Date() } }
        )
        .exec();
    } catch (error) {
      this.logger.error(
        `Terminal notification failed for Scanner job ${job.jobId}: ${this.message(error)}`
      );
    }
  }

  private async cleanupExpiredArtifacts(): Promise<void> {
    const now = new Date();
    const sources = await this.jobs
      .find({ sourceExpiresAt: { $lte: now }, sourceDeletedAt: { $exists: false } })
      .limit(25)
      .exec();
    for (const job of sources) {
      const locators = [
        job.input,
        ...(job.inputs || []).map((item) => item.storage),
        ...job.pages.flatMap((page) => [page.sourceImage, page.thumbnail])
      ].filter(Boolean) as ScannerStorageLocator[];
      await Promise.all(
        locators.map((locator) => this.storage.deleteObject(locator.bucket, locator.objectKey))
      );
      const pages = job.pages.map(
        ({ sourceImage: _sourceImage, thumbnail: _thumbnail, ...page }) => page
      );
      await this.jobs
        .updateOne(
          { _id: job._id, sourceDeletedAt: { $exists: false } },
          { $set: { sourceDeletedAt: now, pages }, $inc: { statusVersion: 1 } }
        )
        .exec();
    }

    const results = await this.jobs
      .find({ resultExpiresAt: { $lte: now }, resultsDeletedAt: { $exists: false } })
      .limit(25)
      .exec();
    for (const job of results) {
      const locators = uniqueScannerStorageLocators([
        job.musicXmlBundle,
        job.combinedMusicXml,
        job.combinedPdf,
        job.resultsZip,
        job.previewPdf,
        job.previewThumbnail,
        ...job.pages.flatMap((page) => [
          page.musicXml,
          page.reviewedMusicXml,
          page.mergedMusicXml,
          page.pdf,
          ...scannerEngineArtifactLocators(page)
        ])
      ]);
      await Promise.all(
        locators.map((locator) => this.storage.deleteObject(locator.bucket, locator.objectKey))
      );
      const pages = job.pages.map((page) => ({
        pageNumber: page.pageNumber,
        ordinal: page.ordinal || page.pageNumber,
        rotationDegrees: page.rotationDegrees || 0,
        included: page.included !== false,
        status: page.status,
        attempts: page.attempts,
        manualRetries: page.manualRetries || 0,
        idempotencyKey: page.idempotencyKey,
        errorCode: page.errorCode,
        errorMessage: page.errorMessage
      }));
      await this.jobs
        .updateOne(
          { _id: job._id, resultsDeletedAt: { $exists: false } },
          {
            $set: { pages, resultsDeletedAt: now },
            $inc: { statusVersion: 1 },
            $unset: {
              musicXmlBundle: 1,
              combinedMusicXml: 1,
              combinedPdf: 1,
              resultsZip: 1,
              previewPdf: 1,
              previewThumbnail: 1
            }
          }
        )
        .exec();
    }
  }

  private sourceInputs(job: ScannerJobDocument): ScannerSourceInput[] {
    if (job.inputs?.length) return job.inputs;
    return job.input ? [{ originalFilename: job.originalFilename, storage: job.input }] : [];
  }

  private async updateLease(jobId: string, status: 'running' | 'rendering'): Promise<void> {
    await this.jobs
      .updateOne(
        { jobId, leaseOwner: this.workerId, status: { $ne: 'cancelled' } },
        {
          $set: { status, leaseExpiresAt: new Date(Date.now() + this.leaseMs()) },
          $inc: { statusVersion: 1 }
        }
      )
      .exec();
  }

  private async isCancelled(jobId: string): Promise<boolean> {
    const value = await this.jobs.findOne({ jobId }).select({ status: 1 }).lean().exec();
    return value?.status === 'cancelled';
  }

  private async store(
    objectKey: string,
    buffer: Buffer,
    contentType: string
  ): Promise<ScannerStorageLocator> {
    const checksumSha256 = createHash('sha256').update(buffer).digest('hex');
    const stored = await this.storage.putAuxiliaryObject(
      objectKey,
      buffer,
      buffer.length,
      contentType
    );
    return {
      bucket: stored.bucket,
      objectKey: stored.objectKey,
      sizeBytes: buffer.length,
      contentType,
      checksumSha256
    };
  }

  private baseKey(job: ScannerJobDocument): string {
    return `scanner/${this.userHash(job.userId)}/${job.jobId}/results`;
  }

  private sourceBaseKey(job: ScannerJobDocument): string {
    return `scanner/${this.userHash(job.userId)}/${job.jobId}/pages`;
  }

  private userHash(userId: string): string {
    return scannerUserHash(userId, this.config.get<string>('SCANNER_OBJECT_KEY_SALT', ''));
  }

  private leaseMs(): number {
    if (this.config.get<string>('SCANNER_PROVIDER_KIND', 'modal') === 'fake') {
      const testLease = Number(this.config.get<string>('SCANNER_TEST_WORKER_LEASE_MS', ''));
      if (Number.isFinite(testLease) && testLease > 0) return Math.max(5_000, testLease);
    }
    const timeout = Number(this.config.get<string>('SCANNER_PROVIDER_TIMEOUT_MS', '600000'));
    return Math.max(1_200_000, (Number.isFinite(timeout) ? timeout : 600_000) + 300_000);
  }

  private asProviderError(error: unknown): ScannerProviderError {
    if (error instanceof ScannerProviderError) return error;
    return new ScannerProviderError(
      'The scanner worker could not complete this job',
      'internal_worker_error',
      false
    );
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private bool(key: string, fallback: boolean): boolean {
    const value = this.config.get<string>(key, String(fallback)).toLowerCase();
    return value === 'true' || value === '1';
  }
}
