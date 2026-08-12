import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional
} from '@nestjs/common';
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
  ScannerRecognitionRaster,
  ScannerRasterIdentity,
  ScannerSourceInput,
  ScannerStorageLocator
} from './schemas/scanner-job.schema';
import { ScannerAlertService } from './scanner-alert.service';
import { ScannerMergeService } from './scanner-merge.service';
import { ScannerProviderService } from './scanner-provider.service';
import { ScannerTranscodaProviderService } from './scanner-transcoda-provider.service';
import { ScannerTelemetryService } from './scanner-telemetry.service';
import {
  effectivePageMusicXml,
  effectivePageMusicXmlSelection,
  pageMusicXmlSuperseded,
  scannerUserHash
} from './scanner.constants';
import { isRetryableScannerErrorCode, ScannerProviderError } from './scanner.errors';
import {
  SCANNER_ARTIFACT_BUILDERS,
  scannerArtifactInputMatches,
  scannerArtifactInputSignature,
  scannerEngineArtifactLocators,
  scannerEngineManifest,
  uniqueScannerStorageLocators,
  withScannerArtifactInputSignature,
  withScannerEngineRun,
  withScannerHomrRun
} from './scanner-dual-engine';
import type { ScannerArtifactInput, ScannerEngineRun } from './scanner-dual-engine';
import type { ScannerPageProvider, ScannerProviderResult } from './scanner-provider.contract';
import { ScannerEngineDefinition, ScannerEngineRegistry } from './scanner-engine.registry';

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
    code === 'provider_source_revision_missing' ||
    code === 'provider_source_revision_mismatch' ||
    code === 'provider_model_revision_mismatch' ||
    code === 'provider_model_artifact_mismatch' ||
    code === 'provider_container_image_mismatch' ||
    code === 'provider_converter_mismatch' ||
    code === 'provider_execution_provider_mismatch' ||
    code === 'provider_engine_mismatch' ||
    code === 'provider_missing_artifact' ||
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
  private readonly engineDisabledReasons = new Map<string, string>();
  private lastCleanupAt = 0;
  private lastAlertCheckAt = 0;

  constructor(
    @InjectModel(ScannerJob.name)
    private readonly jobs: Model<ScannerJobDocument>,
    private readonly storage: StorageService,
    @Inject(ScannerProviderService)
    private readonly provider: ScannerPageProvider,
    @Inject(ScannerTranscodaProviderService)
    private readonly transcodaProvider: ScannerPageProvider,
    private readonly renderer: DerivativePipelineService,
    private readonly merger: ScannerMergeService,
    private readonly alerts: ScannerAlertService,
    private readonly notifications: NotificationsService,
    private readonly telemetry: ScannerTelemetryService,
    private readonly config: ConfigService,
    @Optional() private readonly registeredEngines?: ScannerEngineRegistry
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
          .check(this.disabledEngineReasons())
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
      else if (job?.reassembleRequestedAt) await this.reassemble(job);
      else if (job) await this.process(job);
    } catch (error) {
      this.logger.error(`Scanner worker tick failed: ${this.message(error)}`);
    } finally {
      this.busy = false;
    }
  }

  private async claim(): Promise<ScannerJobDocument | null> {
    if (!this.bool('SCANNER_ENABLED', false)) {
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
            { status: { $in: PROCESSING_STATUSES }, leaseExpiresAt: { $lt: now } },
            // A finished job whose derivatives were invalidated by review. It
            // keeps its terminal status: the pages really did succeed, and only
            // what was derived from them needs rebuilding.
            //
            // `leaseExpiresAt: null` rather than `$exists: false`: a finished
            // job carries the field with a null value, which `$exists: false`
            // does not match and which `$lt: <date>` cannot match either, since
            // Mongo brackets comparisons by type. `{field: null}` matches both
            // missing and null, which is the state a claimable job is actually
            // in.
            {
              status: { $in: ['succeeded', 'partial'] },
              reassembleRequestedAt: { $ne: null },
              $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lt: now } }]
            }
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

  /**
   * Rebuild a finished job's derived artifacts from its current effective pages.
   *
   * Assembly runs when scanning finishes; review runs afterwards. A correction
   * therefore leaves the combined score, rendered page PDFs and preview
   * describing pages that no longer exist. Reads already withhold those rather
   * than serve them stale, and MusicXML bundles are rebuilt on demand — but
   * anything rendered needs MuseScore, so only this process can replace it.
   *
   * Idempotent by construction: every builder checks its stored input signature
   * against the current effective pages first, so a rebuild with nothing to do
   * re-stores nothing. Running it twice costs a pass over the signatures.
   */
  private async reassemble(job: ScannerJobDocument): Promise<void> {
    const startedAt = Date.now();
    const workspace = await fs.mkdtemp(join(tmpdir(), 'ots-scanner-reassemble-'));
    const userHash = this.telemetry.userHash(job.userId);
    try {
      const enginePlan = this.engineRegistry().planForJob(job);
      let pages = job.pages.map((page) => ({ ...page }) as ScannerPageResult);

      // Page previews first: the combined and preview PDFs are built from them.
      let renderMs = 0;
      for (let index = 0; index < pages.length; index += 1) {
        if (pages[index].status !== 'succeeded') continue;
        const rendered = await this.renderEffectivePage(job, pages[index], userHash);
        const perEngine = await this.renderEnginePreviews(job, rendered.page, userHash);
        pages[index] = perEngine.page;
        renderMs += rendered.renderMs + perEngine.renderMs;
      }

      const successful = pages.filter(
        (page) => page.status === 'succeeded' && effectivePageMusicXml(page, enginePlan)
      );
      if (successful.length === 0) {
        await this.clearReassembly(job);
        return;
      }
      // Against the pages this job was asked to scan, not every page of the
      // source: a job with pages deselected is complete when its included pages
      // are, and comparing to `pageCount` would demote it to partial forever.
      const includedCount = pages.filter((page) => page.included !== false).length;

      const musicXmlBundle = await this.createBundle(job, successful);
      const combined = await this.combinePages(job, successful, job.pageCount);
      const previewPdf = await this.createPreviewPdf(job, successful, workspace);
      const status: 'succeeded' | 'partial' =
        successful.length === includedCount ? 'succeeded' : 'partial';
      const resultsZip = await this.createResultsZip(job, pages, {
        status,
        providerRevision: job.providerRevision,
        modelRevision: job.modelRevision,
        engineProvenance: job.engineProvenance,
        combined
      });

      await this.finish(job, status, pages, {
        musicXmlBundle,
        combinedMusicXml: combined.musicXml,
        combinedPdf: combined.pdf,
        combinedStatus: combined.status,
        combinedReason: combined.reason,
        previewPdf,
        resultsZip,
        providerRevision: job.providerRevision,
        modelRevision: job.modelRevision,
        engineProvenance: job.engineProvenance
      });
      await this.clearReassembly(job);
      this.telemetry.emit('job_reassembled', {
        jobId: job.jobId,
        userHash,
        workerId: this.workerId,
        status,
        generation: job.generation,
        pageCount: job.pageCount,
        renderMs,
        totalMs: Date.now() - startedAt
      });
    } catch (error) {
      // The job keeps its results; only the rebuild failed. Clear the request so
      // one bad rebuild cannot loop, and let the reviewer ask again.
      this.logger.error(`Scanner reassembly failed for ${job.jobId}: ${this.message(error)}`);
      await this.clearReassembly(job);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }

  /**
   * Retire the request this run claimed.
   *
   * Not scoped to the lease: `finish` releases it, so a lease-scoped clear
   * silently matched nothing and the job was reclaimed on every tick — an
   * infinite rebuild loop, observed in the browser before this was fixed.
   *
   * Scoped instead to the request timestamp, so a correction arriving *during*
   * the rebuild survives and is served by the next pass rather than being
   * cleared as though it had been handled.
   */
  private async clearReassembly(job: ScannerJobDocument): Promise<void> {
    await this.jobs
      .findOneAndUpdate(
        {
          jobId: job.jobId,
          reassembleRequestedAt: { $lte: job.reassembleRequestedAt ?? new Date() }
        },
        { $unset: { reassembleRequestedAt: 1 } }
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
          this.withInitialPlannedEngineRuns(
            job,
            this.withHomrCompatibility(job, {
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
          )
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
      const pageFiles = await this.materializeConfiguredPages(job, workspace);
      const priorResults = new Map(
        job.pages.map((page) => [
          page.pageNumber,
          this.withInitialPlannedEngineRuns(
            job,
            this.withHomrCompatibility(job, page, {
              providerRevision: job.providerRevision,
              modelRevision: job.modelRevision,
              provenance: job.engineProvenance
            })
          )
        ])
      );
      const results: ScannerPageResult[] = job.pages
        .filter((page) => page.included === false)
        .map((page) =>
          this.withInitialPlannedEngineRuns(
            job,
            this.withHomrCompatibility(
              job,
              { ...page, status: 'skipped' },
              {
                providerRevision: job.providerRevision,
                modelRevision: job.modelRevision,
                provenance: job.engineProvenance
              }
            )
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
        const image = await fs.readFile(pageFile.path);
        const recognitionRaster = await this.persistRecognitionRaster(
          job,
          prior,
          image,
          pageFile.contentType
        );
        const startingPage = this.withInitialPlannedEngineRuns(
          job,
          this.withHomrCompatibility(
            job,
            {
              ...(prior || {
                pageNumber,
                ordinal: pageNumber,
                rotationDegrees: 0,
                included: true,
                status: 'pending',
                attempts: 0,
                manualRetries: 0,
                idempotencyKey: ''
              }),
              recognitionRaster,
              recognitionRasterHistory: this.recognitionRasterHistory(prior, recognitionRaster)
            },
            { providerRevision, modelRevision, provenance: engineProvenance }
          )
        );
        const pageForRecognition = retryPageNumbers
          ? {
              ...startingPage,
              status: 'pending' as const,
              reviewedMusicXml: undefined,
              mergedMusicXml: undefined,
              pdf: undefined,
              errorCode: undefined,
              errorMessage: undefined
            }
          : startingPage;
        const scanned = await this.scanPlannedEngines({
          job,
          page: pageForRecognition,
          image,
          recognitionRaster: this.recognitionRasterIdentity(recognitionRaster),
          contentType: pageFile.contentType,
          pageNumber,
          detectTitle,
          userHash,
          onPageChange: (current) =>
            this.persistPageProgress(
              job,
              results,
              priorResults,
              current,
              providerRevision,
              modelRevision,
              engineProvenance
            )
        });
        if (await this.isCancelled(job.jobId)) return;
        providerMsTotal += scanned.providerMs;
        let page = scanned.page;
        const homr = page.engines?.homr;
        if (homr?.status === 'succeeded') {
          providerRevision = homr.providerRevision;
          modelRevision = homr.modelRevision;
          engineProvenance = homr.provenance;
        }
        const rendered = await this.renderEffectivePage(job, page, userHash);
        page = rendered.page;
        renderMsTotal += rendered.renderMs;
        previewThumbnail ??= rendered.thumbnail;
        const perEngine = await this.renderEnginePreviews(job, page, userHash);
        page = perEngine.page;
        renderMsTotal += perEngine.renderMs;
        results.push(page);
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
      const enginePlan = this.engineRegistry().planForJob(job);
      const successful = results.filter(
        (page) => page.status === 'succeeded' && effectivePageMusicXml(page, enginePlan)
      );
      if (successful.length === 0) {
        const firstFailure = results.find((page) => page.status === 'failed');
        const primaryFailure = firstFailure?.engines?.[enginePlan.primaryEngineId];
        await this.finish(job, 'failed', results, {
          errorCode: primaryFailure?.errorCode || firstFailure?.errorCode || 'scan_failed',
          errorMessage:
            primaryFailure?.errorMessage ||
            firstFailure?.errorMessage ||
            'No pages could be scanned',
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
        ? withScannerArtifactInputSignature(
            await this.store(`${this.baseKey(job)}/preview.png`, previewThumbnail, 'image/png'),
            SCANNER_ARTIFACT_BUILDERS.previewThumbnail,
            this.artifactInputs(successful, enginePlan)
          )
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

  private withInitialPlannedEngineRuns(
    job: ScannerJobDocument,
    page: ScannerPageResult
  ): ScannerPageResult {
    let current = page;
    for (const engineId of this.engineRegistry().planForJob(job).engineIds) {
      const existing = current.engines?.[engineId];
      if (existing) {
        // A page excluded after preparation already carries seeded runs. Left
        // alone they stay 'pending', so an excluded page reports as still
        // awaiting an engine that will never be asked to read it.
        const abandoned =
          page.included === false && (existing.status === 'pending' || existing.status === 'running');
        current = withScannerEngineRun(
          current,
          abandoned ? { ...existing, status: 'skipped' } : existing
        );
        continue;
      }
      const readable = this.engineRegistry().readable(engineId);
      current = withScannerEngineRun(current, {
        engine: engineId,
        status: page.included === false ? 'skipped' : readable ? 'pending' : 'failed',
        attempts: 0,
        idempotencyKey: '',
        ...(!readable
          ? {
              errorCode: 'engine_not_registered',
              errorMessage: `Scanner engine ${engineId} is not registered for execution`
            }
          : {}),
        artifacts: {}
      });
    }
    return current;
  }

  /** Lazy-read/dual-write bridge for jobs whose immutable plan still contains HOMR. */
  private withHomrCompatibility(
    job: ScannerJobDocument,
    page: ScannerPageResult,
    metadata: {
      providerRevision?: string;
      modelRevision?: string;
      provenance?: ScannerEngineProvenance;
    } = {}
  ): ScannerPageResult {
    if (!this.engineRegistry().planForJob(job).engineIds.includes('homr')) return page;
    return page.engines?.homr
      ? withScannerEngineRun(page, page.engines.homr)
      : withScannerHomrRun(page, metadata);
  }

  private async scanPlannedEngines(input: {
    job: ScannerJobDocument;
    page: ScannerPageResult;
    image: Buffer;
    recognitionRaster: ScannerRasterIdentity;
    contentType: 'image/png' | 'image/jpeg';
    pageNumber: number;
    detectTitle: boolean;
    userHash: string;
    onPageChange?: (page: ScannerPageResult) => Promise<void>;
  }): Promise<{ page: ScannerPageResult; providerMs: number }> {
    /**
     * Engines are independent recognitions of the same image, so they run
     * concurrently: a page costs the slowest engine rather than the sum, and a
     * slow engine no longer holds a fast one's result hostage. Only each
     * engine's own preview depends on that engine.
     *
     * `scanEnginePage` changes a page solely through `withScannerEngineRun`, so
     * every run can start from the same base state and be folded back
     * afterwards. Progress reporting is the one shared thing: each engine
     * reports its own run, which is merged into one page here so a concurrent
     * report cannot persist a page that has forgotten the other engine.
     */
    let page = input.page;
    let providerMs = 0;

    const mergeRun = async (run: ScannerEngineRun | undefined): Promise<void> => {
      if (!run) return;
      page = withScannerEngineRun(page, run);
      await input.onPageChange?.(page);
    };

    const cancelled = await this.isCancelled(input.job.jobId);
    const planned = cancelled ? [] : this.engineRegistry().planForJob(input.job).engineIds;

    const unregistered = planned.filter((engineId) => !this.engineRegistry().readable(engineId));
    for (const engineId of unregistered) {
      await mergeRun({
        engine: engineId,
        status: 'failed',
        attempts: 0,
        providerAttempts: page.engines?.[engineId]?.providerAttempts,
        idempotencyKey: page.engines?.[engineId]?.idempotencyKey || '',
        errorCode: 'engine_not_registered',
        errorMessage: `Scanner engine ${engineId} is not registered for execution`,
        recognitionRaster: input.recognitionRaster,
        artifacts: page.engines?.[engineId]?.artifacts || {}
      });
      this.telemetry.emit('page_engine_failed', {
        jobId: input.job.jobId,
        userHash: input.userHash,
        pageNumber: input.pageNumber,
        ordinal: input.page.ordinal || input.pageNumber,
        generation: input.job.generation,
        engine: engineId,
        attempt: 0,
        inputBytes: input.image.length,
        errorCode: 'engine_not_registered',
        retryable: false
      });
    }

    const runnable = planned.flatMap((engineId) => {
      const definition = this.engineRegistry().readable(engineId);
      return definition ? [{ engineId, definition }] : [];
    });

    await this.updateLease(input.job.jobId, 'running');
    const outcomes = await Promise.all(
      runnable.map(async ({ engineId, definition }) => {
        const scanned = await this.scanEnginePage({
          ...input,
          page: input.page,
          definition,
          // Report this engine's run only; the merge above owns the page.
          onPageChange: input.onPageChange
            ? async (partial) => mergeRun(partial.engines?.[engineId])
            : undefined
        });
        return { engineId, scanned };
      })
    );

    for (const { engineId, scanned } of outcomes) {
      providerMs += scanned.providerMs;
      page = withScannerEngineRun(page, scanned.page.engines![engineId]!);
    }
    return { page, providerMs };
  }

  private async scanEnginePage(input: {
    job: ScannerJobDocument;
    page: ScannerPageResult;
    image: Buffer;
    recognitionRaster: ScannerRasterIdentity;
    contentType: 'image/png' | 'image/jpeg';
    pageNumber: number;
    detectTitle: boolean;
    userHash: string;
    definition: ScannerEngineDefinition;
    onPageChange?: (page: ScannerPageResult) => Promise<void>;
  }): Promise<{ page: ScannerPageResult; providerMs: number }> {
    const { definition } = input;
    const prior = input.page.engines?.[definition.id];
    const inputSha256 = createHash('sha256').update(input.image).digest('hex');
    if (
      input.recognitionRaster.checksumSha256 !== inputSha256 ||
      !Number.isInteger(input.recognitionRaster.width) ||
      input.recognitionRaster.width <= 0 ||
      !Number.isInteger(input.recognitionRaster.height) ||
      input.recognitionRaster.height <= 0
    ) {
      throw new ScannerProviderError(
        'Scanner run recognition-raster identity does not match its input',
        'provider_input_digest_mismatch',
        false
      );
    }
    const idempotencyKey = definition.adapter.createIdempotencyKey({
      inputSha256,
      pageNumber: input.pageNumber,
      detectTitle: input.detectTitle,
      generation: input.job.generation
    });
    if (
      prior?.status === 'succeeded' &&
      prior.idempotencyKey === idempotencyKey &&
      Object.entries(definition.artifacts)
        .filter(([, artifact]) => artifact.requiredProviderOutput)
        .every(([kind]) => Boolean(this.engineArtifact(prior, kind)))
    ) {
      return {
        page: withScannerEngineRun(input.page, {
          ...prior,
          recognitionRaster: input.recognitionRaster
        }),
        providerMs: 0
      };
    }
    if (prior && this.shouldPreservePriorFailure(prior, idempotencyKey)) {
      return {
        page: withScannerEngineRun(input.page, {
          ...prior,
          recognitionRaster: input.recognitionRaster
        }),
        providerMs: 0
      };
    }
    const disabledReason = this.engineDisabledReasons.get(definition.id);
    if (disabledReason) {
      return {
        page: withScannerEngineRun(input.page, {
          engine: definition.id,
          status: 'skipped',
          attempts: 0,
          providerAttempts: prior?.providerAttempts,
          idempotencyKey,
          recognitionRaster: input.recognitionRaster,
          errorCode: 'provider_disabled',
          errorMessage: disabledReason,
          artifacts: prior?.artifacts || {}
        }),
        providerMs: 0
      };
    }

    const runningPage = withScannerEngineRun(input.page, {
      engine: definition.id,
      status: 'running',
      attempts: prior?.attempts || 0,
      providerAttempts: prior?.providerAttempts,
      idempotencyKey,
      recognitionRaster: input.recognitionRaster,
      artifacts: prior?.artifacts || {}
    });
    await input.onPageChange?.(runningPage);

    this.telemetry.emit('page_engine_started', {
      jobId: input.job.jobId,
      userHash: input.userHash,
      pageNumber: input.pageNumber,
      ordinal: input.page.ordinal || input.pageNumber,
      generation: input.job.generation,
      engine: definition.id,
      inputBytes: input.image.length,
      providerKind: this.config.get<string>(definition.providerKindConfigKey, 'modal')
    });
    if (definition.id === 'homr') {
      this.telemetry.emit('page_started', {
        jobId: input.job.jobId,
        userHash: input.userHash,
        pageNumber: input.pageNumber,
        ordinal: input.page.ordinal || input.pageNumber,
        generation: input.job.generation,
        manualRetries: input.page.manualRetries || 0,
        inputBytes: input.image.length,
        providerKind: this.config.get<string>(definition.providerKindConfigKey, 'modal')
      });
    }
    const startedAt = Date.now();
    try {
      const scanned = await this.scanWithRetry(
        {
          image: input.image,
          contentType: input.contentType,
          pageNumber: input.pageNumber,
          generation: input.job.generation,
          detectTitle: input.detectTitle,
          idempotencyKey
        },
        definition.adapter,
        definition.budgetExhaustedConfigKey
      );
      if (scanned.result.engine !== definition.id) {
        throw new ScannerProviderError(
          `Scanner provider returned engine ${scanned.result.engine || 'unknown'} for ${definition.id}`,
          'provider_engine_mismatch',
          false
        );
      }
      if (await this.isCancelled(input.job.jobId)) {
        return { page: runningPage, providerMs: Date.now() - startedAt };
      }
      const pageSegment = String(input.pageNumber).padStart(3, '0');
      const storedArtifacts: Record<string, ScannerStorageLocator> = {};
      const providerArtifacts = this.providerResultArtifacts(scanned.result);
      try {
        for (const [kind, artifact] of Object.entries(definition.artifacts)) {
          const body = providerArtifacts[kind];
          if (!body) {
            if (!artifact.requiredProviderOutput) continue;
            throw new ScannerProviderError(
              `Scanner ${definition.displayName} provider returned no ${kind} artifact`,
              'provider_missing_artifact',
              false
            );
          }
          const maxBytes = artifact.maxBytesConfigKey
            ? this.number(artifact.maxBytesConfigKey, artifact.maxBytes)
            : artifact.maxBytes;
          if (body.length > maxBytes) {
            throw new ScannerProviderError(
              `Scanner ${definition.displayName} ${kind} exceeds the ${maxBytes} byte limit`,
              'provider_response_too_large',
              false
            );
          }
          storedArtifacts[kind] = await this.store(
            `${this.baseKey(input.job)}/page-${pageSegment}-${definition.id}.${artifact.extension}`,
            body,
            artifact.contentType
          );
        }
        if (await this.isCancelled(input.job.jobId)) {
          await Promise.all(
            Object.values(storedArtifacts).map((locator) =>
              this.storage.deleteObject(locator.bucket, locator.objectKey)
            )
          );
          return { page: runningPage, providerMs: Date.now() - startedAt };
        }
      } catch (error) {
        await Promise.all(
          Object.values(storedArtifacts).map((locator) =>
            this.storage.deleteObject(locator.bucket, locator.objectKey)
          )
        );
        throw error;
      }

      const providerMs = Date.now() - startedAt;
      const runArtifacts = Object.fromEntries(
        Object.entries(storedArtifacts).map(([kind, locator]) => [
          kind === 'musicxml' ? 'musicXml' : kind,
          locator
        ])
      );
      const run: ScannerEngineRun = {
        engine: definition.id,
        status: 'succeeded',
        attempts: scanned.attempts,
        providerAttempts: (prior?.providerAttempts || 0) + scanned.attempts,
        idempotencyKey,
        recognitionRaster: input.recognitionRaster,
        providerRequestId: scanned.result.requestId,
        durationMs: providerMs,
        inferenceMs: scanned.result.inferenceMs,
        generation: scanned.result.generation,
        completeness: scanned.result.completeness,
        review: scanned.result.review,
        providerRevision: scanned.result.providerRevision,
        modelRevision: scanned.result.modelRevision,
        provenance: scanned.result.provenance,
        artifacts: runArtifacts
      };
      const page = withScannerEngineRun(runningPage, run);
      this.telemetry.emit('page_engine_succeeded', {
        jobId: input.job.jobId,
        userHash: input.userHash,
        pageNumber: input.pageNumber,
        ordinal: input.page.ordinal || input.pageNumber,
        generation: input.job.generation,
        engine: definition.id,
        attempt: scanned.attempts,
        providerAttempts: run.providerAttempts,
        providerRequestId: scanned.result.requestId,
        providerRevision: scanned.result.providerRevision,
        modelRevision: scanned.result.modelRevision,
        executionProvider: scanned.result.provenance.executionProvider,
        providerMs,
        inferenceMs: scanned.result.inferenceMs,
        inputBytes: input.image.length,
        outputBytes: Object.values(providerArtifacts).reduce((sum, body) => sum + body.length, 0)
      });
      if (definition.id === 'homr') {
        this.telemetry.emit('page_succeeded', {
          jobId: input.job.jobId,
          userHash: input.userHash,
          pageNumber: input.pageNumber,
          ordinal: input.page.ordinal || input.pageNumber,
          generation: input.job.generation,
          attempt: scanned.attempts,
          providerAttempts: run.providerAttempts,
          providerRequestId: scanned.result.requestId,
          providerRevision: scanned.result.providerRevision,
          modelRevision: scanned.result.modelRevision,
          executionProvider: scanned.result.provenance.executionProvider,
          providerMs,
          inferenceMs: scanned.result.inferenceMs,
          inputBytes: input.image.length,
          outputBytes: scanned.result.musicXml.length
        });
      }
      return { page, providerMs };
    } catch (error) {
      const providerError = this.asProviderError(error);
      if (disablesProvider(providerError.code)) {
        this.engineDisabledReasons.set(definition.id, providerError.message);
        this.logger.error(`Disabling ${definition.displayName} provider: ${providerError.message}`);
        this.telemetry.emit('provider_disabled', {
          jobId: input.job.jobId,
          userHash: input.userHash,
          pageNumber: input.pageNumber,
          engine: definition.id,
          errorCode: providerError.code,
          retryable: false
        });
      }
      const attempts =
        (providerError as ScannerProviderError & { attempts?: number }).attempts ?? 1;
      const providerMs = Date.now() - startedAt;
      const page = withScannerEngineRun(runningPage, {
        engine: definition.id,
        status: 'failed',
        attempts,
        providerAttempts: (prior?.providerAttempts || 0) + attempts,
        idempotencyKey,
        recognitionRaster: input.recognitionRaster,
        durationMs: providerMs,
        errorCode: providerError.code,
        errorMessage: providerError.message,
        artifacts: prior?.artifacts || {}
      });
      this.telemetry.emit('page_engine_failed', {
        jobId: input.job.jobId,
        userHash: input.userHash,
        pageNumber: input.pageNumber,
        ordinal: input.page.ordinal || input.pageNumber,
        generation: input.job.generation,
        engine: definition.id,
        attempt: attempts,
        providerMs,
        inputBytes: input.image.length,
        errorCode: providerError.code,
        retryable: providerError.retryable
      });
      if (definition.id === 'homr') {
        this.telemetry.emit('page_failed', {
          jobId: input.job.jobId,
          userHash: input.userHash,
          pageNumber: input.pageNumber,
          ordinal: input.page.ordinal || input.pageNumber,
          generation: input.job.generation,
          attempt: attempts,
          providerMs,
          inputBytes: input.image.length,
          errorCode: providerError.code,
          retryable: providerError.retryable
        });
      }
      return { page, providerMs };
    }
  }

  /**
   * Materialize one preview per engine that produced a reading.
   *
   * The effective preview above answers "what did this page become"; a reviewer
   * comparing engines needs to see what *each* engine made of the scan, beside
   * the scan itself. Engines already selected as effective keep the preview
   * they were just given rather than rendering the same MusicXML twice.
   */
  private async renderEnginePreviews(
    job: ScannerJobDocument,
    page: ScannerPageResult,
    userHash: string
  ): Promise<{ page: ScannerPageResult; renderMs: number }> {
    let rendered = page;
    let renderMs = 0;
    for (const engineId of this.engineRegistry().planForJob(job).engineIds) {
      const run = rendered.engines?.[engineId];
      const musicXml = run?.artifacts.musicXml;
      if (!run || !musicXml) continue;
      if (!this.engineRegistry().get(engineId)?.artifacts.pdf) continue;
      const inputs = [
        { ordinal: page.ordinal || page.pageNumber, checksumSha256: musicXml.checksumSha256 }
      ];
      if (scannerArtifactInputMatches(run.artifacts.pdf, SCANNER_ARTIFACT_BUILDERS.pagePdf, inputs))
        continue;

      const startedAt = Date.now();
      try {
        await this.updateLease(job.jobId, 'rendering');
        const body = await this.storage.getObjectBuffer(musicXml.bucket, musicXml.objectKey);
        const output = await this.renderer.renderMusicXmlPdf(body);
        const pdf = withScannerArtifactInputSignature(
          await this.store(
            `${this.baseKey(job)}/page-${String(page.pageNumber).padStart(3, '0')}-${engineId}.pdf`,
            output.pdf,
            'application/pdf'
          ),
          SCANNER_ARTIFACT_BUILDERS.pagePdf,
          inputs
        );
        rendered = withScannerEngineRun(rendered, {
          ...run,
          artifacts: { ...run.artifacts, pdf }
        });
      } catch (error) {
        // One engine's preview failing must not cost the other its preview, nor
        // the page its result.
        this.logger.warn(
          `PDF rendering failed for ${job.jobId} page ${page.pageNumber} ${engineId}: ${this.message(error)}`
        );
        this.telemetry.emit('page_render_failed', {
          jobId: job.jobId,
          userHash,
          pageNumber: page.pageNumber,
          engine: engineId,
          errorCode: 'render_failed',
          retryable: true
        });
      }
      renderMs += Date.now() - startedAt;
    }
    return { page: rendered, renderMs };
  }

  /** Materialize the page preview from the plan-selected MusicXML, regardless of engine. */
  private async renderEffectivePage(
    job: ScannerJobDocument,
    page: ScannerPageResult,
    userHash: string
  ): Promise<{ page: ScannerPageResult; renderMs: number; thumbnail?: Buffer }> {
    const selection = effectivePageMusicXmlSelection(page, this.engineRegistry().planForJob(job));
    if (!selection) return { page, renderMs: 0 };
    const musicXml = selection.musicXml;
    const inputs = [
      {
        ordinal: page.ordinal || page.pageNumber,
        checksumSha256: musicXml.checksumSha256
      }
    ];
    const current = page.pdf?.inputSignature
      ? scannerArtifactInputMatches(page.pdf, SCANNER_ARTIFACT_BUILDERS.pagePdf, inputs)
      : Boolean(page.pdf) && !pageMusicXmlSuperseded(page);
    if (current) return { page, renderMs: 0 };

    const startedAt = Date.now();
    try {
      await this.updateLease(job.jobId, 'rendering');
      const body = await this.storage.getObjectBuffer(musicXml.bucket, musicXml.objectKey);
      const rendered = await this.renderer.renderMusicXmlPdf(body);
      const pdf = withScannerArtifactInputSignature(
        await this.store(
          `${this.baseKey(job)}/page-${String(page.pageNumber).padStart(3, '0')}.pdf`,
          rendered.pdf,
          'application/pdf'
        ),
        SCANNER_ARTIFACT_BUILDERS.pagePdf,
        inputs
      );
      let renderedPage: ScannerPageResult = { ...page, pdf };
      const selectedRun = selection.engineId ? page.engines?.[selection.engineId] : undefined;
      const selectedDefinition = selection.engineId
        ? this.engineRegistry().get(selection.engineId)
        : undefined;
      if (selectedRun && selectedDefinition?.artifacts.pdf) {
        renderedPage = withScannerEngineRun(renderedPage, {
          ...selectedRun,
          artifacts: { ...selectedRun.artifacts, pdf }
        });
      }
      return {
        page: renderedPage,
        renderMs: Date.now() - startedAt,
        thumbnail: rendered.thumbnail
      };
    } catch (error) {
      this.logger.warn(
        `PDF rendering failed for ${job.jobId} page ${page.pageNumber}: ${this.message(error)}`
      );
      this.telemetry.emit('page_render_failed', {
        jobId: job.jobId,
        userHash,
        pageNumber: page.pageNumber,
        errorCode: 'render_failed',
        retryable: true
      });
      return { page, renderMs: Date.now() - startedAt };
    }
  }

  private engineArtifact(run: ScannerEngineRun, kind: string): ScannerStorageLocator | undefined {
    return kind === 'musicxml' ? run.artifacts.musicXml : run.artifacts[kind];
  }

  private providerResultArtifacts(result: ScannerProviderResult): Record<string, Buffer> {
    const artifacts = { ...(result.nativeArtifacts || {}) };
    if (result.kern && !artifacts.kern) artifacts.kern = result.kern;
    artifacts.musicxml = result.musicXml;
    return artifacts;
  }

  private engineRegistry(): ScannerEngineRegistry {
    return (
      this.registeredEngines ||
      new ScannerEngineRegistry(
        this.config,
        this.provider as ScannerProviderService,
        this.transcodaProvider as ScannerTranscodaProviderService
      )
    );
  }

  private disabledEngineReasons(): Record<string, string> {
    return Object.fromEntries(this.engineDisabledReasons);
  }

  private async scanWithRetry(
    input: {
      image: Buffer;
      contentType?: 'image/png' | 'image/jpeg';
      pageNumber: number;
      generation?: number;
      detectTitle: boolean;
      idempotencyKey: string;
    },
    provider: ScannerPageProvider = this.provider,
    budgetKey = 'SCANNER_PROVIDER_BUDGET_EXHAUSTED'
  ): Promise<{
    result: Awaited<ReturnType<ScannerPageProvider['scanPage']>>;
    attempts: number;
  }> {
    let attempt = 0;
    while (attempt < 2) {
      attempt += 1;
      if (this.bool(budgetKey, false)) {
        throw new ScannerProviderError(
          'Scanner monthly capacity has been reached',
          'provider_budget_exhausted',
          false
        );
      }
      try {
        const contentType = input.contentType || 'image/png';
        const result = await provider.scanPage({
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
    prior: { status: string; idempotencyKey: string; errorCode?: string },
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
        this.withHomrCompatibility(job, page, {
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

  private recognitionRasterIdentity(raster: ScannerRecognitionRaster): ScannerRasterIdentity {
    return {
      checksumSha256: raster.checksumSha256,
      width: raster.width,
      height: raster.height
    };
  }

  private recognitionRasterHistory(
    page: ScannerPageResult | undefined,
    current: ScannerRecognitionRaster
  ): ScannerRecognitionRaster[] | undefined {
    const history = new Map<string, ScannerRecognitionRaster>();
    for (const raster of [
      ...(page?.recognitionRasterHistory || []),
      ...(page?.recognitionRaster ? [page.recognitionRaster] : [])
    ]) {
      if (raster.checksumSha256 !== current.checksumSha256) {
        history.set(`${raster.storage.bucket}/${raster.storage.objectKey}`, raster);
      }
    }
    return history.size > 0 ? [...history.values()] : undefined;
  }

  /** Persist the exact post-rotation bytes used by every engine on this page. */
  private async persistRecognitionRaster(
    job: ScannerJobDocument,
    page: ScannerPageResult | undefined,
    image: Buffer,
    contentType: 'image/png' | 'image/jpeg'
  ): Promise<ScannerRecognitionRaster> {
    const metadata = await sharp(image).metadata();
    const width = Number(metadata.width || 0);
    const height = Number(metadata.height || 0);
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
      throw new ScannerProviderError(
        'The recognition raster dimensions could not be read',
        'source_page_missing',
        false
      );
    }
    const checksumSha256 = createHash('sha256').update(image).digest('hex');
    const current = page?.recognitionRaster;
    if (
      current?.checksumSha256 === checksumSha256 &&
      current.width === width &&
      current.height === height
    ) {
      return current;
    }
    const extension = contentType === 'image/jpeg' ? 'jpg' : 'png';
    const pageSegment = String(page?.pageNumber || 0).padStart(3, '0');
    const storage = await this.store(
      `${this.sourceBaseKey(job)}/page-${pageSegment}-recognition-g${job.generation}-${checksumSha256.slice(0, 16)}.${extension}`,
      image,
      contentType
    );
    return { storage, checksumSha256, width, height };
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
          const source = effectivePageMusicXml(page, this.engineRegistry().planForJob(job));
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

      const inputs = this.artifactInputs(successful, this.engineRegistry().planForJob(job));
      const musicXml = withScannerArtifactInputSignature(
        await this.store(
          `${this.baseKey(job)}/combined.musicxml`,
          merged.musicXml,
          'application/vnd.recordare.musicxml+xml'
        ),
        SCANNER_ARTIFACT_BUILDERS.combinedMusicXml,
        inputs
      );
      // A render failure does not invalidate good MusicXML (section 3.5), but
      // MuseScore refusing to load the assembly is the strongest signal we have
      // that it is not musically usable, so it downgrades to 'failed'.
      let pdf: ScannerStorageLocator | undefined;
      try {
        const rendered = await this.renderer.renderMusicXmlPdf(merged.musicXml);
        pdf = withScannerArtifactInputSignature(
          await this.store(`${this.baseKey(job)}/combined.pdf`, rendered.pdf, 'application/pdf'),
          SCANNER_ARTIFACT_BUILDERS.combinedPdf,
          inputs
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
    const enginePlan = this.engineRegistry().planForJob(job);
    const onlyPage = effectivePageMusicXml(pages[0], enginePlan);
    const inputs = this.artifactInputs(pages, enginePlan);
    if (job.pageCount === 1 && onlyPage) {
      return withScannerArtifactInputSignature(
        onlyPage,
        SCANNER_ARTIFACT_BUILDERS.musicXmlBundle,
        inputs
      );
    }
    const zip = new AdmZip();
    for (const page of pages) {
      const pageMusicXml = effectivePageMusicXml(page, enginePlan);
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
    return withScannerArtifactInputSignature(
      await this.store(
        `${this.baseKey(job)}/musicxml-pages.zip`,
        zip.toBuffer(),
        'application/zip'
      ),
      SCANNER_ARTIFACT_BUILDERS.musicXmlBundle,
      inputs
    );
  }

  private async createPreviewPdf(
    job: ScannerJobDocument,
    pages: ScannerPageResult[],
    workspace: string
  ): Promise<ScannerStorageLocator | undefined> {
    const pdfPages = pages.filter((page) =>
      this.materializedArtifactIsCurrent(
        page.pdf,
        SCANNER_ARTIFACT_BUILDERS.pagePdf,
        [page],
        pageMusicXmlSuperseded(page)
      )
    );
    if (pdfPages.length !== pages.length) return undefined;
    const inputs = this.artifactInputs(pdfPages, this.engineRegistry().planForJob(job));
    if (pdfPages.length === 1 && pdfPages[0].pdf) {
      return withScannerArtifactInputSignature(
        pdfPages[0].pdf,
        SCANNER_ARTIFACT_BUILDERS.previewPdf,
        inputs
      );
    }
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
      return withScannerArtifactInputSignature(
        await this.store(
          `${this.baseKey(job)}/preview.pdf`,
          await fs.readFile(combined),
          'application/pdf'
        ),
        SCANNER_ARTIFACT_BUILDERS.previewPdf,
        inputs
      );
    } catch (error) {
      this.logger.warn(`Unable to combine scanner preview PDF: ${this.message(error)}`);
      return undefined;
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
    const enginePlan = this.engineRegistry().planForJob(job);
    const inputs = this.artifactInputs(pages, enginePlan);
    for (const page of pages) {
      const pageSegment = String(page.ordinal || page.pageNumber).padStart(3, '0');
      const pageMusicXml = effectivePageMusicXml(page, enginePlan);
      if (pageMusicXml) {
        zip.addFile(
          `page-${pageSegment}.musicxml`,
          await this.storage.getObjectBuffer(pageMusicXml.bucket, pageMusicXml.objectKey)
        );
      }
      if (
        this.materializedArtifactIsCurrent(
          page.pdf,
          SCANNER_ARTIFACT_BUILDERS.pagePdf,
          [page],
          pageMusicXmlSuperseded(page)
        )
      ) {
        zip.addFile(
          `page-${pageSegment}.pdf`,
          await this.storage.getObjectBuffer(page.pdf.bucket, page.pdf.objectKey)
        );
      }

      // Every engine's own reading, beside the effective one. A download that
      // carried only the selected engine would silently discard the second
      // transcription the job was run to produce.
      // The page's own runs, not just the plan's: a legacy job can carry a run
      // for an engine its inferred plan does not list, and dropping it here
      // would silently shrink the download.
      const zipEngineIds = [
        ...new Set([...enginePlan.engineIds, ...Object.keys(page.engines || {})])
      ];
      for (const engineId of zipEngineIds) {
        const run = page.engines?.[engineId];
        const definition = this.engineRegistry().get(engineId);
        if (!run || !definition) continue;
        for (const [kind, locator] of Object.entries(run.artifacts)) {
          if (!locator) continue;
          const extension = definition.artifacts[kind === 'musicXml' ? 'musicxml' : kind]?.extension;
          if (!extension) continue;
          zip.addFile(
            `engines/${engineId}/page-${pageSegment}.${extension}`,
            await this.storage.getObjectBuffer(locator.bucket, locator.objectKey)
          );
        }
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
      enginePlan: this.engineRegistry().planForJob(job),
      serviceRevision: summary.providerRevision,
      modelRevision: summary.modelRevision,
      // Design section 7.1/17: the weights are versioned separately from the
      // HOMR commit, so a result is only reproducible with both recorded.
      engineProvenance: summary.engineProvenance,
      inputSignature: scannerArtifactInputSignature({
        builderVersion: SCANNER_ARTIFACT_BUILDERS.resultsZip,
        pages: inputs
      }),
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
        engines: scannerEngineManifest(page),
        musicXmlSha256: effectivePageMusicXml(page, enginePlan)?.checksumSha256,
        pdfSha256: this.materializedArtifactIsCurrent(
          page.pdf,
          SCANNER_ARTIFACT_BUILDERS.pagePdf,
          [page],
          pageMusicXmlSuperseded(page)
        )
          ? page.pdf?.checksumSha256
          : undefined
      }))
    };
    zip.addFile('scanner-manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
    zip.addFile('README.txt', Buffer.from(this.readmeText(summary.combined)));
    return withScannerArtifactInputSignature(
      await this.store(`${this.baseKey(job)}/results.zip`, zip.toBuffer(), 'application/zip'),
      SCANNER_ARTIFACT_BUILDERS.resultsZip,
      inputs
    );
  }

  private artifactInputs(
    pages: ScannerPageResult[],
    enginePlan?: { primaryEngineId: string; fallbackEngineIds: string[] }
  ): ScannerArtifactInput[] {
    return [...pages]
      .sort(
        (left, right) => (left.ordinal || left.pageNumber) - (right.ordinal || right.pageNumber)
      )
      .flatMap((page) => {
        const musicXml = effectivePageMusicXml(page, enginePlan);
        if (!musicXml) return [];
        if (!musicXml.checksumSha256) {
          throw new Error(`Scanner page ${page.pageNumber} has no MusicXML checksum`);
        }
        return [
          {
            ordinal: page.ordinal || page.pageNumber,
            checksumSha256: musicXml.checksumSha256
          }
        ];
      });
  }

  private materializedArtifactIsCurrent(
    locator: ScannerStorageLocator | undefined,
    builderVersion: string,
    pages: ScannerPageResult[],
    legacyInvalidated: boolean
  ): boolean {
    if (!locator) return false;
    if (locator.inputSignature) {
      return scannerArtifactInputMatches(locator, builderVersion, this.artifactInputs(pages));
    }
    return !legacyInvalidated;
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
        ...job.pages.flatMap((page) => [
          page.sourceImage,
          page.thumbnail,
          page.recognitionRaster?.storage,
          ...(page.recognitionRasterHistory || []).map((raster) => raster.storage)
        ])
      ].filter(Boolean) as ScannerStorageLocator[];
      await Promise.all(
        locators.map((locator) => this.storage.deleteObject(locator.bucket, locator.objectKey))
      );
      const pages = job.pages.map(
        ({
          sourceImage: _sourceImage,
          thumbnail: _thumbnail,
          recognitionRaster: _recognitionRaster,
          recognitionRasterHistory: _recognitionRasterHistory,
          ...page
        }) => page
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
    const timeout = Math.max(
      ...this.engineRegistry()
        .allDefinitions()
        .filter((definition) => definition.readable)
        .map((definition) => {
          const configured = Number(this.config.get<string>(definition.timeoutConfigKey, '600000'));
          return Number.isFinite(configured) ? configured : 600_000;
        })
    );
    return Math.max(1_200_000, timeout + 300_000);
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
