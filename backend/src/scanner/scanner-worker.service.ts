import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
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
import { StorageService } from '../storage/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DerivativePipelineService } from '../works/derivative-pipeline.service';
import {
  ScannerJob,
  ScannerJobDocument,
  ScannerPageResult,
  ScannerStorageLocator
} from './schemas/scanner-job.schema';
import { ScannerProviderService } from './scanner-provider.service';
import { isRetryableScannerErrorCode, ScannerProviderError } from './scanner.errors';

const execFileAsync = promisify(execFile);
const PROCESSING_STATUSES = ['preparing', 'running', 'rendering'];

@Injectable()
export class ScannerWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScannerWorkerService.name);
  private readonly workerId = `${process.pid}-${randomUUID()}`;
  private timer?: NodeJS.Timeout;
  private busy = false;
  private providerDisabledReason?: string;
  private lastCleanupAt = 0;

  constructor(
    @InjectModel(ScannerJob.name)
    private readonly jobs: Model<ScannerJobDocument>,
    private readonly storage: StorageService,
    private readonly provider: ScannerProviderService,
    private readonly renderer: DerivativePipelineService,
    private readonly notifications: NotificationsService,
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
      await this.deliverPendingTerminalNotification();
      const job = await this.claim();
      if (job) await this.process(job);
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
            { status: 'queued' },
            { status: { $in: PROCESSING_STATUSES }, leaseExpiresAt: { $lt: now } }
          ]
        },
        {
          $set: {
            status: 'preparing',
            leaseOwner: this.workerId,
            leaseExpiresAt,
            startedAt: now
          }
        },
        { new: true, sort: { createdAt: 1 } }
      )
      .exec();
  }

  private async process(job: ScannerJobDocument): Promise<void> {
    const workspace = await fs.mkdtemp(join(tmpdir(), 'ots-scanner-worker-'));
    try {
      if (this.providerDisabledReason) {
        throw new ScannerProviderError(this.providerDisabledReason, 'provider_disabled', false);
      }
      const input = await this.storage.getObjectBuffer(job.input.bucket, job.input.objectKey);
      const pageFiles = await this.preparePages(job, input, workspace);
      const priorResults = new Map(job.pages.map((page) => [page.pageNumber, page]));
      const results: ScannerPageResult[] = [];
      let providerRevision = job.providerRevision;
      let modelRevision = job.modelRevision;
      let previewThumbnail: Buffer | undefined;

      await this.updateLease(job.jobId, 'running');
      for (let index = 0; index < pageFiles.length; index += 1) {
        const pageNumber = index + 1;
        if (await this.isCancelled(job.jobId)) return;
        const prior = priorResults.get(pageNumber);
        const idempotencyKey = this.provider.createIdempotencyKey({
          inputSha256: job.input.checksumSha256,
          pageNumber,
          detectTitle: Boolean(job.options?.detectTitle),
          generation: job.generation
        });
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

        if (prior && this.shouldPreservePriorFailure(prior, idempotencyKey)) {
          results.push(prior);
          continue;
        }

        const image = await fs.readFile(pageFiles[index].path);

        try {
          const scanned = await this.scanWithRetry({
            image,
            contentType: pageFiles[index].contentType,
            pageNumber,
            detectTitle: Boolean(job.options?.detectTitle),
            idempotencyKey
          });
          if (await this.isCancelled(job.jobId)) return;
          providerRevision = scanned.result.providerRevision;
          modelRevision = scanned.result.modelRevision;
          const musicXml = await this.store(
            `${this.baseKey(job)}/page-${String(pageNumber).padStart(3, '0')}.musicxml`,
            scanned.result.musicXml,
            'application/vnd.recordare.musicxml+xml'
          );

          let pdf: ScannerStorageLocator | undefined;
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
          }
          if (await this.isCancelled(job.jobId)) {
            await this.storage.deleteObject(musicXml.bucket, musicXml.objectKey);
            if (pdf) await this.storage.deleteObject(pdf.bucket, pdf.objectKey);
            return;
          }
          results.push({
            pageNumber,
            status: 'succeeded',
            attempts: scanned.attempts,
            idempotencyKey,
            musicXml,
            pdf
          });
        } catch (error) {
          const providerError = this.asProviderError(error);
          if (
            providerError.code === 'provider_service_revision_mismatch' ||
            providerError.code === 'provider_model_revision_mismatch' ||
            providerError.code === 'provider_execution_provider_mismatch' ||
            providerError.code === 'provider_input_digest_mismatch'
          ) {
            this.providerDisabledReason = providerError.message;
            this.logger.error(`Disabling scanner provider: ${providerError.message}`);
          }
          results.push({
            pageNumber,
            status: 'failed',
            attempts: (providerError as ScannerProviderError & { attempts?: number }).attempts ?? 1,
            idempotencyKey,
            errorCode: providerError.code,
            errorMessage: providerError.message
          });
        }
        await this.jobs
          .updateOne(
            { jobId: job.jobId, status: { $ne: 'cancelled' } },
            { $set: { pages: results, providerRevision, modelRevision } }
          )
          .exec();
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
          modelRevision
        });
        return;
      }

      const musicXmlBundle = await this.createBundle(job, successful);
      const previewPdf = await this.createPreviewPdf(job, successful, workspace);
      const previewThumbnailLocator = previewThumbnail
        ? await this.store(`${this.baseKey(job)}/preview.png`, previewThumbnail, 'image/png')
        : job.previewThumbnail;
      const status = successful.length === job.pageCount ? 'succeeded' : 'partial';
      await this.finish(job, status, results, {
        musicXmlBundle,
        previewPdf,
        previewThumbnail: previewThumbnailLocator,
        providerRevision,
        modelRevision,
        ...(!previewPdf
          ? {
              errorCode: 'preview_render_failed',
              errorMessage: 'MusicXML is ready, but the PDF preview could not be rendered'
            }
          : {})
      });
    } catch (error) {
      if (!(await this.isCancelled(job.jobId))) {
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
    detectTitle: boolean;
    idempotencyKey: string;
  }): Promise<{
    result: Awaited<ReturnType<ScannerProviderService['scanPage']>>;
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
          filename: `page-${input.pageNumber}.${contentType === 'image/jpeg' ? 'jpg' : 'png'}`,
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
      }
    }
    throw new ScannerProviderError('Scanner provider failed', 'provider_failed', false);
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

  private async preparePages(
    job: ScannerJobDocument,
    input: Buffer,
    workspace: string
  ): Promise<Array<{ path: string; contentType: 'image/png' | 'image/jpeg' }>> {
    if (job.inputContentType !== 'application/pdf') {
      const extension = job.inputContentType === 'image/png' ? '.png' : '.jpg';
      const path = join(workspace, `page-001${extension}`);
      await fs.writeFile(path, input);
      return [
        {
          path,
          contentType: job.inputContentType === 'image/png' ? 'image/png' : 'image/jpeg'
        }
      ];
    }
    const pdfPath = join(workspace, 'source.pdf');
    const outputPrefix = join(workspace, 'page');
    await fs.writeFile(pdfPath, input);
    await execFileAsync(
      'pdftoppm',
      ['-png', '-scale-to-x', '1920', '-scale-to-y', '-1', pdfPath, outputPrefix],
      { timeout: 120_000, maxBuffer: 5 * 1024 * 1024 }
    );
    const entries = await fs.readdir(workspace);
    const pages = entries
      .filter((name) => /^page-\d+\.png$/.test(name))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
      .map((name) => ({ path: join(workspace, name), contentType: 'image/png' as const }));
    if (pages.length !== job.pageCount) {
      throw new ScannerProviderError(
        `Expected ${job.pageCount} PDF pages but rasterized ${pages.length}`,
        'pdf_rasterization_failed',
        false
      );
    }
    return pages;
  }

  private async createBundle(
    job: ScannerJobDocument,
    pages: ScannerPageResult[]
  ): Promise<ScannerStorageLocator> {
    if (job.pageCount === 1 && pages[0].musicXml) return pages[0].musicXml;
    const zip = new AdmZip();
    for (const page of pages) {
      if (!page.musicXml) continue;
      const contents = await this.storage.getObjectBuffer(
        page.musicXml.bucket,
        page.musicXml.objectKey
      );
      zip.addFile(`page-${String(page.pageNumber).padStart(3, '0')}.musicxml`, contents);
    }
    return this.store(`${this.baseKey(job)}/musicxml-pages.zip`, zip.toBuffer(), 'application/zip');
  }

  private async createPreviewPdf(
    job: ScannerJobDocument,
    pages: ScannerPageResult[],
    workspace: string
  ): Promise<ScannerStorageLocator | undefined> {
    const pdfPages = pages.filter((page) => page.pdf);
    if (pdfPages.length === 0) return undefined;
    if (pdfPages.length === 1 && pdfPages[0].pdf) return pdfPages[0].pdf;
    const paths: string[] = [];
    for (const page of pdfPages) {
      const path = join(workspace, `rendered-${String(page.pageNumber).padStart(3, '0')}.pdf`);
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

  private async finish(
    job: ScannerJobDocument,
    status: 'succeeded' | 'partial' | 'failed',
    pages: ScannerPageResult[],
    values: Record<string, any>
  ): Promise<void> {
    const completedAt = new Date();
    const updated = await this.jobs
      .findOneAndUpdate(
        { jobId: job.jobId, status: { $ne: 'cancelled' } },
        {
          $set: {
            status,
            pages,
            completedAt,
            leaseExpiresAt: null,
            leaseOwner: null,
            ...values
          }
        },
        { new: true }
      )
      .exec();
    if (updated) await this.notifyTerminal(updated);
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
        pageCount: job.pageCount
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
      await this.storage.deleteObject(job.input.bucket, job.input.objectKey);
      await this.jobs
        .updateOne(
          { _id: job._id, sourceDeletedAt: { $exists: false } },
          { $set: { sourceDeletedAt: now } }
        )
        .exec();
    }

    const results = await this.jobs
      .find({ resultExpiresAt: { $lte: now }, resultsDeletedAt: { $exists: false } })
      .limit(25)
      .exec();
    for (const job of results) {
      const locators = [
        job.musicXmlBundle,
        job.previewPdf,
        job.previewThumbnail,
        ...job.pages.flatMap((page) => [page.musicXml, page.pdf])
      ].filter(Boolean) as ScannerStorageLocator[];
      await Promise.all(
        locators.map((locator) => this.storage.deleteObject(locator.bucket, locator.objectKey))
      );
      const pages = job.pages.map((page) => ({
        pageNumber: page.pageNumber,
        status: page.status,
        attempts: page.attempts,
        idempotencyKey: page.idempotencyKey,
        errorCode: page.errorCode,
        errorMessage: page.errorMessage
      }));
      await this.jobs
        .updateOne(
          { _id: job._id, resultsDeletedAt: { $exists: false } },
          {
            $set: { pages, resultsDeletedAt: now },
            $unset: { musicXmlBundle: 1, previewPdf: 1, previewThumbnail: 1 }
          }
        )
        .exec();
    }
  }

  private async updateLease(jobId: string, status: 'running' | 'rendering'): Promise<void> {
    await this.jobs
      .updateOne(
        { jobId, leaseOwner: this.workerId, status: { $ne: 'cancelled' } },
        { $set: { status, leaseExpiresAt: new Date(Date.now() + this.leaseMs()) } }
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
    return `scanner/${job.userId}/${job.jobId}/generation-${job.generation}`;
  }

  private leaseMs(): number {
    const timeout = Number(this.config.get<string>('SCANNER_PROVIDER_TIMEOUT_MS', '600000'));
    return Math.max(1_200_000, (Number.isFinite(timeout) ? timeout : 600_000) + 300_000);
  }

  private asProviderError(error: unknown): ScannerProviderError {
    if (error instanceof ScannerProviderError) return error;
    return new ScannerProviderError(this.message(error), 'internal_worker_error', false);
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private bool(key: string, fallback: boolean): boolean {
    const value = this.config.get<string>(key, String(fallback)).toLowerCase();
    return value === 'true' || value === '1';
  }
}
