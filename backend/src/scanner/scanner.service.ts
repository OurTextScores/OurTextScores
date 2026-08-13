import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
  PayloadTooLargeException,
  ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extname } from 'node:path';
import AdmZip = require('adm-zip');
import sharp = require('sharp');
import { StorageService } from '../storage/storage.service';
import {
  ScannerJob,
  ScannerJobDocument,
  ScannerMergedDecision,
  ScannerMergedScore,
  ScannerPageResult,
  ScannerSourceInput,
  ScannerStorageLocator
} from './schemas/scanner-job.schema';
import { assertValidMusicXml } from './scanner-musicxml';
import { spliceScannerMeasures } from './scanner-splice';
import { reconcileScannerPartLayout } from './scanner-part-layout';
import { transferScannerMarkings } from './scanner-marking-transfer';
import { readScannerSpliceFacts } from './scanner-splice-safety';
import {
  identityMeasureMap,
  resolveMergedAnchor,
  resolveMergedIndexes,
  withInsertedMeasures,
  withRemovedMeasures
} from './scanner-merged-measure-map';


import {
  effectivePageMusicXml,
  effectivePageMusicXmlSelection,
  pageMusicXmlSuperseded,
  SCANNER_MAX_MERGED_SCORE_BYTES,
  SCANNER_UPLOAD_DIRECTORY,
  scannerUserHash
} from './scanner.constants';
import {
  comparisonCropRects,
  CropLevel,
  cropForLevel,
  staffBandWithinContext
} from './scanner-crop';
import { locateSymbol } from './scanner-locate';

/** Field order within a captured token; mirrors the provider's capture. */
const TOKEN_FIELDS = ['rhythm', 'pitch', 'lift', 'articulation', 'slur', 'position'];
import {
  DEFAULT_REVIEW_THRESHOLDS,
  homrReviewVoicesForRegeneration,
  pageSuitability,
  remainingFloor,
  selectSpots
} from './scanner-review';
import { ScannerAlertService } from './scanner-alert.service';
import { ScannerProviderService } from './scanner-provider.service';
import { ScannerCorrection, ScannerCorrectionDocument } from './schemas/scanner-correction.schema';
import {
  ScannerMergeDecision,
  ScannerMergeDecisionDocument,
  type ScannerMergeOutcome
} from './schemas/scanner-merge-decision.schema';
import { ScannerTelemetryService } from './scanner-telemetry.service';
import { isRetryableScannerErrorCode } from './scanner.errors';
import { ScannerEngineRegistry } from './scanner-engine.registry';
import { scannerEngineOperationalMetrics } from './scanner-engine-operations';
import type { ScannerPageProvider } from './scanner-provider.contract';
import {
  SCANNER_ARTIFACT_BUILDERS,
  SCANNER_BLOCK_CONTENT_SIGNATURE_VERSION,
  SCANNER_COMPARE_REGIONS_VERSION,
  scannerArtifactInputSignature,
  scannerArtifactInputMatches,
  scannerDefaultEnginePlan,
  scannerEngineArtifactLocators,
  scannerEngineManifest,
  scannerEnginePlanForJob,
  scannerEngineReviewContentSignature,
  scannerHomrRun,
  scannerMergedScoreBasis,
  scannerMergedScoreStale,
  isScannerEngineId,
  uniqueScannerStorageLocators,
  withScannerEngineRun,
  withScannerHomrRun
} from './scanner-dual-engine';
import type {
  ScannerArtifactInput,
  ScannerEngineId,
  ScannerEngineRun,
  ScannerMeasureCropRegion
} from './scanner-dual-engine';
import type { ScannerRasterIdentity } from './schemas/scanner-job.schema';
import { compareScannerPage, SCANNER_PAGE_COMPARISON_VERSION } from './scanner-page-comparison';
import { SCANNER_MEASURE_GEOMETRY_VERSION } from './scanner-comparison-geometry';

const execFileAsync = promisify(execFile);
const ACTIVE_STATUSES = ['queued', 'preparing', 'ready', 'running', 'rendering'];
const SCANNER_JOB_ARTIFACT_KINDS = new Set(['musicxml', 'pdf', 'thumbnail', 'zip']);
const SCANNER_ENGINE_ARTIFACT_KIND_PATTERN = /^[a-z0-9][a-z0-9.-]{0,31}$/;
const MAX_SCANNER_COMPARISON_CROP_SYSTEMS = 64;
const MAX_SCANNER_COMPARISON_CROP_PIXELS = 30_000_000;
const SCANNER_COMPARISON_CROP_GUTTER = 8;

@Injectable()
export class ScannerService implements OnModuleInit {
  private readonly logger = new Logger(ScannerService.name);

  constructor(
    @InjectModel(ScannerJob.name)
    private readonly jobs: Model<ScannerJobDocument>,
    @InjectModel(ScannerCorrection.name)
    private readonly corrections: Model<ScannerCorrectionDocument>,
    private readonly storage: StorageService,
    private readonly provider: ScannerProviderService,
    private readonly telemetry: ScannerTelemetryService,
    private readonly alerts: ScannerAlertService,
    private readonly config: ConfigService,
    @Optional() private readonly registeredEngines?: ScannerEngineRegistry,
    // Optional so every existing construction of this service — and there are
    // many, in tests — keeps working; a missing model simply records nothing.
    @Optional()
    @InjectModel(ScannerMergeDecision.name)
    private readonly mergeDecisions?: Model<ScannerMergeDecisionDocument>
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await fs.mkdir(SCANNER_UPLOAD_DIRECTORY, { recursive: true });
      const entries = await fs.readdir(SCANNER_UPLOAD_DIRECTORY);
      const staleBefore = Date.now() - 24 * 60 * 60 * 1000;
      await Promise.all(
        entries.map(async (entry) => {
          const path = `${SCANNER_UPLOAD_DIRECTORY}/${entry}`;
          const stat = await fs.stat(path);
          if (stat.isFile() && stat.mtimeMs < staleBefore) await fs.rm(path, { force: true });
        })
      );
    } catch (error) {
      this.logger.warn(
        `Unable to clean stale Scanner upload files: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  assertAvailable(userId: string): void {
    if (!this.bool('SCANNER_ENABLED', false)) {
      throw new ServiceUnavailableException('Scanner is not currently available');
    }
    const allowlist = this.config
      .get<string>('SCANNER_BETA_USER_IDS', '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (!allowlist.includes('*') && !allowlist.includes(userId)) {
      throw new ForbiddenException('Scanner beta access is not enabled for this account');
    }
  }

  async createJob(input: {
    userId: string;
    files: Express.Multer.File[];
    detectTitle?: boolean;
  }): Promise<any> {
    this.assertAvailable(input.userId);
    if (this.providerCapacityExhausted()) {
      throw new ServiceUnavailableException('Scanner monthly capacity has been reached');
    }
    const maxBytes = this.number('SCANNER_MAX_UPLOAD_BYTES', 25 * 1024 * 1024);
    const files = this.sortUploadedFiles(input.files || []);
    if (files.length === 0 || files.some((file) => !file.path)) {
      throw new BadRequestException('A score image or PDF is required');
    }
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > maxBytes) {
      throw new PayloadTooLargeException(`Combined upload exceeds the ${maxBytes} byte limit`);
    }

    const maxDimension = this.number('SCANNER_MAX_IMAGE_DIMENSION', 12_000);
    const maxPixels = this.number('SCANNER_MAX_IMAGE_PIXELS', 80_000_000);
    const maxAspectRatio = this.number('SCANNER_MAX_IMAGE_ASPECT_RATIO', 20);
    const detectedFiles: Array<{ file: Express.Multer.File; contentType: string }> = [];
    for (const file of files) {
      const contentType = await this.detectInputType(file.path);
      if (contentType !== 'application/pdf') {
        const dimensions = await this.readImageDimensions(file.path, maxPixels);
        const aspectRatio =
          Math.max(dimensions.width, dimensions.height) /
          Math.min(dimensions.width, dimensions.height);
        if (
          dimensions.width > maxDimension ||
          dimensions.height > maxDimension ||
          dimensions.width * dimensions.height > maxPixels ||
          aspectRatio > maxAspectRatio
        ) {
          throw new PayloadTooLargeException(
            `Image dimensions exceed the ${maxDimension}px/${maxPixels}-pixel/${maxAspectRatio}:1 aspect-ratio limit`
          );
        }
      }
      detectedFiles.push({ file, contentType });
    }
    const pdfFiles = detectedFiles.filter((item) => item.contentType === 'application/pdf');
    if (pdfFiles.length > 0 && detectedFiles.length !== 1) {
      throw new BadRequestException('Upload one PDF by itself, or upload only PNG/JPEG images');
    }

    const pageCount = pdfFiles.length
      ? await this.readPdfPageCount(pdfFiles[0].file.path)
      : detectedFiles.length;
    const maxPages = this.number('SCANNER_MAX_PAGES', 20);
    if (pageCount > maxPages) {
      const label = pdfFiles.length ? 'PDF' : 'Image selection';
      throw new PayloadTooLargeException(
        `${label} has ${pageCount} pages; the limit is ${maxPages}`
      );
    }

    await this.assertQuota(input.userId, pageCount);

    const jobId = randomUUID();
    const storedInputs: ScannerSourceInput[] = [];
    const now = Date.now();

    try {
      for (let index = 0; index < detectedFiles.length; index += 1) {
        const { file, contentType } = detectedFiles[index];
        const extension =
          contentType === 'application/pdf'
            ? '.pdf'
            : contentType === 'image/png'
              ? '.png'
              : '.jpg';
        const objectKey = `scanner/${this.userHash(input.userId)}/${jobId}/source-${String(index + 1).padStart(3, '0')}${extension}`;
        const checksumSha256 = await this.hashFile(file.path);
        const stored = await this.storage.putRawObject(
          objectKey,
          createReadStream(file.path),
          file.size,
          contentType
        );
        storedInputs.push({
          originalFilename: this.safeFilename(file.originalname, extension),
          storage: {
            bucket: stored.bucket,
            objectKey: stored.objectKey,
            sizeBytes: file.size,
            contentType,
            checksumSha256
          }
        });
      }
      const originalFilename =
        storedInputs.length === 1
          ? storedInputs[0].originalFilename
          : `${storedInputs[0].originalFilename} + ${storedInputs.length - 1} more`;
      const job = await this.jobs.create({
        jobId,
        userId: input.userId,
        status: 'preparing',
        originalFilename,
        inputContentType:
          detectedFiles.length === 1 ? detectedFiles[0].contentType : 'multipart/mixed',
        pageCount,
        inputs: storedInputs,
        options: { detectTitle: Boolean(input.detectTitle) },
        generation: 1,
        enginePlan: this.newJobEnginePlan(),
        pages: Array.from({ length: pageCount }, (_value, index) =>
          withScannerHomrRun({
            pageNumber: index + 1,
            ordinal: index + 1,
            rotationDegrees: 0,
            included: true,
            status: 'pending',
            attempts: 0,
            manualRetries: 0,
            idempotencyKey: ''
          })
        ),
        sourceExpiresAt: new Date(
          now + this.number('SCANNER_SOURCE_RETENTION_DAYS', 7) * 86_400_000
        ),
        resultExpiresAt: new Date(
          now + this.number('SCANNER_RESULT_RETENTION_DAYS', 30) * 86_400_000
        )
      });
      this.telemetry.emit('job_created', {
        jobId,
        userHash: this.userHash(input.userId),
        status: 'preparing',
        pageCount,
        inputBytes: totalBytes
      });
      await this.telemetry.trackJobCreated({
        userId: input.userId,
        pageCount,
        inputContentType: String(job.inputContentType)
      });
      return this.present(job);
    } catch (error) {
      await Promise.all(
        storedInputs.map((item) =>
          this.storage.deleteObject(item.storage.bucket, item.storage.objectKey)
        )
      );
      throw error;
    }
  }

  /**
   * Design section 8.2. Newest first, with an opaque cursor that carries both
   * `createdAt` and `jobId` so jobs created in the same millisecond cannot be
   * skipped or repeated across pages.
   */
  async listJobs(
    userId: string,
    options: { limit?: number; cursor?: string } = {}
  ): Promise<{ items: any[]; nextCursor: string | null }> {
    this.assertAvailable(userId);
    const limit = Math.min(Math.max(Math.floor(options.limit || 20), 1), 100);
    const filter: Record<string, any> = { userId };
    const after = this.decodeCursor(options.cursor);
    if (after) {
      filter.$or = [
        { createdAt: { $lt: after.createdAt } },
        { createdAt: after.createdAt, jobId: { $lt: after.jobId } }
      ];
    }
    const jobs = await this.jobs
      .find(filter)
      .sort({ createdAt: -1, jobId: -1 })
      // One extra row tells us whether another page exists without a count.
      .limit(limit + 1)
      .exec();
    const page = jobs.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((job) => this.present(job)),
      nextCursor:
        jobs.length > limit && last
          ? Buffer.from(`${last.createdAt.toISOString()}|${last.jobId}`).toString('base64url')
          : null
    };
  }

  private decodeCursor(cursor?: string): { createdAt: Date; jobId: string } | undefined {
    if (!cursor) return undefined;
    const [timestamp, jobId] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const createdAt = new Date(timestamp);
    if (!jobId || Number.isNaN(createdAt.getTime())) {
      throw new BadRequestException('Invalid pagination cursor');
    }
    return { createdAt, jobId };
  }

  async getJob(userId: string, jobId: string): Promise<any> {
    this.assertAvailable(userId);
    return this.present(await this.ownedJob(userId, jobId));
  }

  async configurePages(
    userId: string,
    jobId: string,
    requestedPages: Array<{
      pageNumber: number;
      ordinal: number;
      rotationDegrees: number;
      included: boolean;
    }>
  ): Promise<any> {
    this.assertAvailable(userId);
    const existing = await this.ownedJob(userId, jobId);
    if (existing.status !== 'ready') {
      throw new ConflictException('Pages can only be configured before scanning starts');
    }
    if (!Array.isArray(requestedPages) || requestedPages.length !== existing.pageCount) {
      throw new BadRequestException('A configuration is required for every page');
    }
    if (
      requestedPages.some(
        (page) =>
          !Number.isInteger(page.pageNumber) ||
          !Number.isInteger(page.ordinal) ||
          !Number.isInteger(page.rotationDegrees) ||
          typeof page.included !== 'boolean'
      )
    ) {
      throw new BadRequestException('Page configuration is invalid');
    }
    const byPageNumber = new Map(requestedPages.map((page) => [page.pageNumber, page]));
    if (byPageNumber.size !== existing.pageCount) {
      throw new BadRequestException('Page numbers must be unique');
    }
    const rotations = new Set([0, 90, 180, 270]);
    const ordinals = requestedPages.map((page) => page.ordinal).sort((left, right) => left - right);
    if (ordinals.some((ordinal, index) => ordinal !== index + 1)) {
      throw new BadRequestException('Page order must contain each position exactly once');
    }
    const pages = existing.pages.map((page) => {
      const requested = byPageNumber.get(page.pageNumber);
      if (!requested || !rotations.has(requested.rotationDegrees)) {
        throw new BadRequestException('Page configuration is invalid');
      }
      return withScannerHomrRun({
        ...page,
        ordinal: requested.ordinal,
        rotationDegrees: requested.rotationDegrees as 0 | 90 | 180 | 270,
        included: Boolean(requested.included),
        status: requested.included ? 'pending' : 'skipped'
      });
    });
    if (!pages.some((page) => page.included)) {
      throw new BadRequestException('At least one page must be included');
    }
    const updated = await this.jobs
      .findOneAndUpdate(
        { _id: existing._id, userId, jobId, status: 'ready' },
        { $set: { pages }, $inc: { statusVersion: 1 } },
        { new: true }
      )
      .exec();
    if (!updated) throw new ConflictException('Scanner job changed; refresh and try again');
    return this.present(updated);
  }

  async startJob(userId: string, jobId: string): Promise<any> {
    this.assertAvailable(userId);
    if (this.providerCapacityExhausted()) {
      throw new ServiceUnavailableException('Scanner monthly capacity has been reached');
    }
    const existing = await this.ownedJob(userId, jobId);
    if (existing.status !== 'ready') {
      throw new ConflictException('Scanner job is not ready to start');
    }
    if (existing.sourceDeletedAt || existing.sourceExpiresAt.getTime() <= Date.now()) {
      throw new ConflictException('The retained source file has expired');
    }
    if (!existing.pages.some((page) => page.included)) {
      throw new BadRequestException('At least one page must be included');
    }
    const updated = await this.jobs
      .findOneAndUpdate(
        { _id: existing._id, userId, jobId, status: 'ready' },
        {
          // `queuedAt` starts the queue-wait clock. `createdAt` would also count
          // the time the user spent on the review screen, which is not waiting.
          $set: { status: 'queued', queuedAt: new Date() },
          $inc: { statusVersion: 1 },
          $unset: { completedAt: 1, errorCode: 1, errorMessage: 1 }
        },
        { new: true }
      )
      .exec();
    if (!updated) throw new ConflictException('Scanner job changed; refresh and try again');
    return this.present(updated);
  }

  async cancelJob(userId: string, jobId: string): Promise<any> {
    this.assertAvailable(userId);
    const job = await this.jobs
      .findOneAndUpdate(
        { userId, jobId, status: { $in: ACTIVE_STATUSES } },
        {
          $set: {
            status: 'cancelled',
            completedAt: new Date(),
            leaseExpiresAt: null,
            leaseOwner: null
          },
          $inc: { statusVersion: 1 }
        },
        { new: true }
      )
      .exec();
    if (job) {
      this.telemetry.emit('job_cancelled', {
        jobId,
        userHash: this.userHash(userId),
        status: 'cancelled',
        pageCount: job.pageCount
      });
      return this.present(job);
    }
    const existing = await this.ownedJob(userId, jobId);
    throw new ConflictException(`Job cannot be cancelled from status ${existing.status}`);
  }

  async retryJob(userId: string, jobId: string): Promise<any> {
    this.assertAvailable(userId);
    if (this.providerCapacityExhausted()) {
      throw new ServiceUnavailableException('Scanner monthly capacity has been reached');
    }
    const existing = await this.ownedJob(userId, jobId);
    const eligibility = this.retryEligibility(existing);
    if (!eligibility.allowed) throw new ConflictException(eligibility.reason);
    return this.queueRetry(existing, this.retryablePageNumbers(existing));
  }

  /**
   * Ask the worker to rebuild this job's derived artifacts.
   *
   * Reviewing a page invalidates everything assembled from it. Reads withhold
   * the stale ones and rebuild MusicXML bundles on demand, but rendered
   * artifacts need MuseScore, which only the worker has. Requesting twice is
   * harmless — the flag is idempotent, and so is the rebuild it triggers.
   */
  async requestReassembly(userId: string, jobId: string): Promise<any> {
    this.assertAvailable(userId);
    const existing = await this.ownedJob(userId, jobId);
    if (!['succeeded', 'partial'].includes(existing.status)) {
      throw new ConflictException('Only a finished scan can be reassembled');
    }
    if (existing.resultsDeletedAt || (existing.resultExpiresAt?.getTime() ?? 0) <= Date.now()) {
      throw new ConflictException('The results for this scan have expired');
    }
    const updated = await this.jobs
      .findOneAndUpdate(
        { jobId, userId, status: { $in: ['succeeded', 'partial'] } },
        { $set: { reassembleRequestedAt: new Date() }, $inc: { statusVersion: 1 } },
        { new: true }
      )
      .exec();
    if (!updated) throw new ConflictException('Scanner job is no longer reassemblable');
    return this.present(updated);
  }

  async retryPage(userId: string, jobId: string, pageNumber: number): Promise<any> {
    this.assertAvailable(userId);
    if (this.providerCapacityExhausted()) {
      throw new ServiceUnavailableException('Scanner monthly capacity has been reached');
    }
    const existing = await this.ownedJob(userId, jobId);
    if (pageNumber < 1 || pageNumber > existing.pageCount) {
      throw new NotFoundException('Scanner page not found');
    }
    const page = existing.pages.find((candidate) => candidate.pageNumber === pageNumber);
    const eligibility = this.pageRetryEligibility(existing, pageNumber, page);
    if (!eligibility.allowed) throw new ConflictException(eligibility.reason);
    return this.queueRetry(existing, [pageNumber]);
  }

  async deleteJob(userId: string, jobId: string): Promise<{ ok: true }> {
    this.assertAvailable(userId);
    const job = await this.ownedJob(userId, jobId);
    if (ACTIVE_STATUSES.includes(job.status)) {
      throw new ConflictException('Cancel the active job before deleting it');
    }
    await this.deleteArtifacts(job);
    await this.jobs.deleteOne({ _id: job._id }).exec();
    return { ok: true };
  }

  async getArtifact(
    userId: string,
    jobId: string,
    kind: string,
    pageNumber?: number,
    engine?: ScannerEngineId
  ): Promise<{ stream: Readable; contentType: string; filename: string }> {
    this.assertAvailable(userId);
    const job = await this.ownedJob(userId, jobId);
    if (pageNumber !== undefined && (pageNumber < 1 || pageNumber > job.pageCount)) {
      throw new NotFoundException('Scanner page not found');
    }
    const pageRequested = pageNumber !== undefined;
    const superseded = job.pages.some((page) => pageMusicXmlSuperseded(page));
    const legacyJobInvalidated = superseded || Boolean(job.combinedStale);
    let locator: ScannerStorageLocator | undefined;
    let filename: string;
    if (engine) {
      if (!isScannerEngineId(engine)) {
        throw new BadRequestException('Invalid scanner engine id');
      }
      if (!pageRequested) {
        throw new BadRequestException('An engine artifact requires a page number');
      }
      if (!SCANNER_ENGINE_ARTIFACT_KIND_PATTERN.test(kind)) {
        throw new BadRequestException('Invalid scanner artifact kind');
      }
      const page = job.pages.find((candidate) => candidate.pageNumber === pageNumber);
      if (!page) throw new NotFoundException('Scanner page not found');
      const enginePlan = this.enginePlanForJob(job);
      if (!enginePlan.engineIds.includes(engine)) {
        throw new BadRequestException('Scanner engine is not part of this job');
      }
      const definition = this.registeredEngines?.readable(engine);
      if (this.registeredEngines && !definition) {
        throw new BadRequestException('Scanner engine is not registered for artifact reads');
      }
      if (!enginePlan.capabilitySnapshots[engine].outputArtifactKinds.includes(kind)) {
        throw new BadRequestException('Artifact kind is not declared by this scanner engine');
      }
      if (definition && !definition.artifacts[kind]) {
        throw new BadRequestException('Artifact kind is not registered for this scanner engine');
      }
      const run =
        engine === 'homr'
          ? scannerHomrRun(page, {
              providerRevision: job.providerRevision,
              modelRevision: job.modelRevision,
              provenance: job.engineProvenance
            })
          : page?.engines?.[engine];
      locator = kind === 'musicxml' ? run?.artifacts.musicXml : run?.artifacts[kind];
      const extension = definition?.artifacts[kind].extension || (kind === 'kern' ? 'krn' : kind);
      filename = `scan-page-${pageNumber}-${engine}.${extension}`;
    } else if (!SCANNER_JOB_ARTIFACT_KINDS.has(kind)) {
      throw new BadRequestException(
        'A provider-native artifact requires an engine and page number'
      );
    } else if (kind === 'zip') {
      if (
        !this.materializedArtifactIsCurrent(
          job.resultsZip,
          SCANNER_ARTIFACT_BUILDERS.resultsZip,
          job.pages,
          legacyJobInvalidated
        )
      ) {
        const body = await this.currentResultsZip(job);
        return {
          stream: Readable.from([body]),
          contentType: 'application/zip',
          filename: 'scan-results.zip'
        };
      }
      locator = job.resultsZip;
      filename = 'scan-results.zip';
    } else if (kind === 'pdf') {
      const page = pageRequested
        ? job.pages.find((candidate) => candidate.pageNumber === pageNumber)
        : undefined;
      // A PDF is a render of a specific MusicXML revision. Never show the raw
      // recognition's render after spot review or reconciliation superseded it.
      if (pageRequested) {
        locator = this.materializedArtifactIsCurrent(
          page?.pdf,
          SCANNER_ARTIFACT_BUILDERS.pagePdf,
          page ? [page] : [],
          pageMusicXmlSuperseded(page)
        )
          ? page?.pdf
          : undefined;
      } else {
        locator = this.materializedArtifactIsCurrent(
          job.combinedPdf,
          SCANNER_ARTIFACT_BUILDERS.combinedPdf,
          job.pages,
          legacyJobInvalidated
        )
          ? job.combinedPdf
          : this.materializedArtifactIsCurrent(
                job.previewPdf,
                SCANNER_ARTIFACT_BUILDERS.previewPdf,
                job.pages,
                legacyJobInvalidated
              )
            ? job.previewPdf
            : undefined;
      }
      filename = pageRequested ? `scan-page-${pageNumber}.pdf` : 'scan-preview.pdf';
    } else if (kind === 'thumbnail') {
      locator = pageRequested
        ? job.pages.find((page) => page.pageNumber === pageNumber)?.thumbnail
        : this.materializedArtifactIsCurrent(
              job.previewThumbnail,
              SCANNER_ARTIFACT_BUILDERS.previewThumbnail,
              job.pages,
              legacyJobInvalidated
            )
          ? job.previewThumbnail
          : undefined;
      filename = pageRequested ? `scan-page-${pageNumber}.png` : 'scan-preview.png';
    } else if (pageRequested) {
      locator = effectivePageMusicXml(
        job.pages.find((page) => page.pageNumber === pageNumber),
        this.enginePlanForJob(job)
      );
      filename = `scan-page-${pageNumber}.musicxml`;
    } else if (
      this.materializedArtifactIsCurrent(
        job.combinedMusicXml,
        SCANNER_ARTIFACT_BUILDERS.combinedMusicXml,
        job.pages,
        legacyJobInvalidated
      )
    ) {
      // A validated assembly is the whole score, so it wins over the per-page
      // bundle for the job-level MusicXML artifact.
      locator = job.combinedMusicXml;
      filename = 'scan-combined.musicxml';
    } else {
      // One reading is a score, not an archive of one — and this is checked
      // before any stored bundle, because a job whose other pages were later
      // excluded still has a zip on disk from when it had several. Counting
      // `pageCount` rather than the pages that actually contribute is what
      // handed the editor a one-entry zip named `.musicxml`, which opened as
      // `File "" is corrupted` from the button offering the finished score.
      const currentPages = this.currentMusicXmlPages(job);
      if (currentPages.length === 1) {
        locator = currentPages[0].musicXml;
        filename = 'scan.musicxml';
      } else if (
        this.materializedArtifactIsCurrent(
          job.musicXmlBundle,
          SCANNER_ARTIFACT_BUILDERS.musicXmlBundle,
          job.pages,
          legacyJobInvalidated
        )
      ) {
        locator = job.musicXmlBundle;
        filename = 'scan-musicxml-pages.zip';
      } else {
        const body = await this.currentMusicXmlBundle(job, currentPages);
        return {
          stream: Readable.from([body]),
          contentType: 'application/zip',
          filename: 'scan-musicxml-pages.zip'
        };
      }
    }
    if (!locator) throw new NotFoundException('Artifact is not available');
    return {
      stream: await this.storage.getObjectStream(locator.bucket, locator.objectKey),
      contentType: locator.contentType,
      filename
    };
  }

  /**
   * Design section 13.4 metrics, and the numbers the section 13.4 alerts would
   * fire on. Aggregates only: no filenames, no score content, no per-user
   * identity, so operational access stays distinct from content access (12.1).
   */
  async metrics(windowHours = 24): Promise<any> {
    const hours = Math.min(Math.max(Math.floor(windowHours) || 24, 1), 24 * 30);
    const since = new Date(Date.now() - hours * 3_600_000);
    const now = Date.now();

    const [byStatus, oldestQueued, recent, alerts] = await Promise.all([
      this.jobs
        .aggregate([
          { $match: { createdAt: { $gte: since } } },
          { $group: { _id: '$status', jobs: { $sum: 1 }, pages: { $sum: '$pageCount' } } }
        ])
        .exec(),
      this.jobs.find({ status: 'queued' }).sort({ queuedAt: 1 }).limit(1).exec(),
      this.jobs
        .find({ createdAt: { $gte: since } })
        .select({ enginePlan: 1, pages: 1 })
        .lean()
        .exec(),
      // The same evaluation the worker pushes on, so the admin panel and any
      // alert channel can never disagree about what is firing.
      this.alerts.evaluate()
    ]);

    const engines = scannerEngineOperationalMetrics(recent as any[]);
    const homr = engines.homr;
    const pagesSucceeded = homr?.pagesByStatus.succeeded || 0;
    const pagesFailed = homr?.pagesByStatus.failed || 0;

    const queueDepth = byStatus
      .filter((row: any) => ['queued', 'running', 'rendering'].includes(row._id))
      .reduce((sum: number, row: any) => sum + row.jobs, 0);

    return {
      windowHours: hours,
      generatedAt: new Date().toISOString(),
      alerts,
      jobs: Object.fromEntries(byStatus.map((row: any) => [row._id, row.jobs])),
      /** Compatibility projection; new consumers should read `engines`. */
      pagesByStatus: { succeeded: pagesSucceeded, failed: pagesFailed },
      queue: {
        depth: queueDepth,
        oldestQueuedAgeMs: oldestQueued[0]?.queuedAt
          ? now - oldestQueued[0].queuedAt.getTime()
          : null
      },
      pageLatencyMs: homr?.pageLatencyMs || { samples: 0, p50: null, p95: null, max: null },
      failureRate: homr?.failureRate || 0,
      failuresByCode: homr?.failuresByCode || {},
      renderSuccessRate: homr?.renderSuccessRate ?? null,
      provider: homr?.provider || { calls: 0, approximateSeconds: 0 },
      engines
    };
  }

  private async assertQuota(userId: string, pages: number): Promise<void> {
    const activeLimit = this.number('SCANNER_MAX_ACTIVE_JOBS_PER_USER', 2);
    const active = await this.jobs
      .countDocuments({ userId, status: { $in: ACTIVE_STATUSES } })
      .exec();
    if (active >= activeLimit) {
      throw new ConflictException(`At most ${activeLimit} scanner jobs may be active`);
    }
    const since = new Date(Date.now() - 86_400_000);
    const usage = await this.jobs
      .aggregate([
        { $match: { userId, createdAt: { $gte: since } } },
        { $group: { _id: null, pages: { $sum: '$pageCount' } } }
      ])
      .exec();
    const used = Number(usage[0]?.pages || 0);
    const limit = this.number('SCANNER_ROLLING_24H_PAGE_QUOTA', 50);
    if (used + pages > limit) {
      throw new PayloadTooLargeException(
        `This upload would exceed the ${limit}-page rolling 24-hour quota`
      );
    }
  }

  /**
   * The review queue for one page (design section 4).
   *
   * Selection runs here rather than being stored, so the thresholds can be
   * retuned against real reviewer behaviour without re-scanning the page.
   */
  async pageReview(userId: string, jobId: string, pageNumber: number): Promise<any> {
    this.assertAvailable(userId);
    const job = await this.ownedJob(userId, jobId);
    const page = job.pages.find((entry) => entry.pageNumber === pageNumber);
    if (!page) throw new NotFoundException('Scanner page not found');
    if (page.mergedMusicXml) {
      throw new ConflictException('Spot review is unavailable after engine reconciliation');
    }

    const reviewEngine = this.reviewEngineForPage(job, page);
    const staves = reviewEngine.run.review?.staves || [];
    const thresholds = this.reviewThresholds();
    const spots = selectSpots(staves, thresholds);
    const suitability = pageSuitability(staves, spots);

    return {
      pageNumber,
      status: page.status,
      engineId: reviewEngine.engineId,
      contentSignature: scannerEngineReviewContentSignature(reviewEngine.run),
      // No cap and no truncation: the reviewer stops when the remainder is good
      // enough, which is what `remainingFloor` is for.
      spots: spots.map((spot, index) => {
        const staff = staves.find((entry: any) => entry.index === spot.staffIndex);
        const band = locateSymbol(staff?.tokens, spot.symbolIndex, staff?.symbols);
        // The context crop holds the staves above and below, so the band needs
        // to know which slice of it is the staff being asked about — otherwise
        // it highlights all three.
        const raster = page.recognitionRaster;
        const vertical =
          band && raster
            ? staffBandWithinContext(
                staff?.region,
                { width: raster.width, height: raster.height },
                staves
                  .filter((entry: any) => entry.index !== spot.staffIndex)
                  .map((entry: any) => entry.region)
              )
            : null;
        return {
          id: index,
          head: spot.head,
          chosen: spot.chosen,
          confidence: spot.confidence,
          alternatives: spot.alternatives,
          staffIndex: spot.staffIndex,
          symbolIndex: spot.symbolIndex,
          // Where to point on the staff crop. Without this the reviewer is
          // asked "which duration is this?" over a line of thirty notes.
          band: band && vertical
            ? { ...band, contextTop: vertical.top, contextHeight: vertical.height }
            : band
        };
      }),
      remainingFloor: remainingFloor(spots, 0),
      suitability
    };
  }

  /** Build a fresh, read-only comparison from the selected stored engine revisions. */
  /**
   * The comparison projected for a renderer that only needs to know what to
   * highlight.
   *
   * The score editor computes its own measure diff, and cannot tell these two
   * documents apart: HOMR writes a sixteenth as duration 1 at divisions 4 and
   * Transcoda writes the same note as 2520 at divisions 10080, so a textual
   * per-measure signature marks every measure of an agreeing page as changed.
   * This hands it the answer instead. See
   * OTS_Web/docs/private/SCANNER_COMPARATOR_DESIGN_2026-08-12.md.
   */
  async pageComparisonRegions(
    userId: string,
    jobId: string,
    pageNumber: number,
    baseEngineId: string,
    candidateEngineId: string
  ): Promise<any> {
    const comparison = await this.pageComparison(
      userId,
      jobId,
      pageNumber,
      baseEngineId,
      candidateEngineId
    );

    const side = (value: any) => ({
      engineId: value.engineId,
      displayName: value.displayName,
      artifactChecksumSha256: value.artifactChecksumSha256,
      completeness: value.completeness,
      unsupportedSemanticClasses: value.unsupportedSemanticClasses || []
    });

    // The merged score travels with the regions document because the embed
    // reaches this process only through the frontend's proxy and cannot
    // construct scanner URLs of its own. Same reasoning as `cropUrl` below.
    const job = await this.ownedJob(userId, jobId);
    const page = job.pages.find((entry) => entry.pageNumber === pageNumber);
    // `../` because these resolve against *this document's* URL, which ends
    // `…/pages/N/comparison/regions`. A bare `merged` would land on
    // `…/comparison/merged`, which is not a route — unlike `cropUrl` below,
    // whose target really does live under `comparison/`.
    const merged = page
      ? {
          ...this.mergedScoreState(job, page),
          url: '../merged',
          musicXmlUrl: `../merged/musicxml?revision=${page.mergedScore?.revision ?? 0}`
        }
      : undefined;

    const base = {
      version: SCANNER_COMPARE_REGIONS_VERSION,
      statusVersion: comparison.statusVersion,
      merged,
      // Two different questions, and conflating them would withhold highlights
      // that are perfectly good. `analysisStatus` says whether the measure
      // comparison itself succeeded, which is all highlighting needs.
      // `status` is page-wide and includes geometry, which gates crops and, in
      // phase D, decisions — a page is refused if any single block's location
      // cannot be proven.
      analysisStatus: comparison.analysis?.status === 'succeeded' ? 'succeeded' : 'refused',
      status: comparison.status,
      left: side(comparison.base),
      right: side(comparison.candidate),
      // The scan's own lines, for a row-per-system view. Present even when the
      // page-wide join refuses: the systems are known regardless of whether
      // every block's location could be proven.
      systems: (comparison.systems || []).map((system: any) => ({
        systemIndex: system.systemIndex,
        region: system.region,
        leftMeasureIndexes: system.baseMeasureIndexes,
        rightMeasureIndexes: system.candidateMeasureIndexes,
        // Relative to this document's own URL, so it resolves correctly
        // whatever prefix the caller reached us through — the browser arrives
        // via the frontend's proxy, which this process cannot know. Built here
        // rather than by the client because the crop is status-version bound,
        // and a consumer assembling it would be one refactor away from pinning
        // the wrong revision.
        cropUrl:
          `systems/${system.systemIndex}/crop?` +
          new URLSearchParams({
            baseEngine: baseEngineId,
            candidateEngine: candidateEngineId,
            statusVersion: String(comparison.statusVersion)
          }).toString()
      })),
      regions: [] as any[],
      warnings: [] as any[],
      refusalReasons: comparison.refusalReasons || []
    };
    if (comparison.analysis?.status !== 'succeeded') return base;

    // Part ordinals can differ between engines — part 0 in one may match part 2
    // in the other — so each side carries its own index. Change review's single
    // partIndex works only because both its sides are revisions of one score.
    const ordinals = new Map<string, { left?: number; right?: number }>();
    for (const match of comparison.analysis.partMatches || []) {
      if (match.outcome !== 'matched') continue;
      ordinals.set(match.stablePartKey, {
        left: match.base?.ordinal,
        right: match.candidate?.ordinal
      });
    }

    const groundedBlockIndexes = new Set(
      (comparison.geometry?.blocks || [])
        .filter((entry: any) => entry.status === 'ready')
        .map((entry: any) => entry.block.blockIndex)
    );

    /**
     * Where a block sits inside the system crop that contains it.
     *
     * The scan crop a reader looks at is the whole system; the difference is
     * some bars of it. Sent as fractions of that crop rather than scan pixels
     * so the consumer can draw the box over an image it has scaled to fit,
     * without knowing the scan's dimensions or how it was resized.
     */
    const systemRegions = new Map<number, number[]>(
      (comparison.systems || []).map((system: any) => [system.systemIndex, system.region])
    );
    const cropBoxesFor = (blockIndex: number) => {
      const entry = (comparison.geometry?.blocks || []).find(
        (candidate: any) => candidate.status === 'ready' && candidate.block.blockIndex === blockIndex
      );
      return (entry?.block?.cropRegions || []).flatMap((crop: any) => {
        const system = systemRegions.get(crop.systemIndex);
        if (!system || !Array.isArray(crop.region)) return [];
        const width = system[2] - system[0];
        const height = system[3] - system[1];
        if (!(width > 0) || !(height > 0)) return [];
        return [
          {
            systemIndex: crop.systemIndex,
            left: (crop.region[0] - system[0]) / width,
            top: (crop.region[1] - system[1]) / height,
            width: (crop.region[2] - crop.region[0]) / width,
            height: (crop.region[3] - crop.region[1]) / height
          }
        ];
      });
    };

    /**
     * How a reader would say which bars a block covers.
     *
     * Built here because measure *numbers* live on the refs, which the regions
     * payload does not carry — and because MusicXML labels need not be numeric
     * or contiguous, so "11-12" is a claim about the document rather than
     * arithmetic the consumer can do on indexes.
     */
    const measureLabel = (refs: any[]): string => {
      const numbers = refs.map((ref) => ref.measureNumber).filter(Boolean);
      if (numbers.length === 0) return '';
      if (numbers.length === 1) return `bar ${numbers[0]}`;
      const first = Number(numbers[0]);
      const last = Number(numbers[numbers.length - 1]);
      const contiguous =
        Number.isFinite(first) &&
        Number.isFinite(last) &&
        last - first === numbers.length - 1 &&
        numbers.every((value: string, index: number) => Number(value) === first + index);
      return contiguous
        ? `bars ${numbers[0]}-${numbers[numbers.length - 1]}`
        : `bars ${numbers.join(', ')}`;
    };

    const warnings = new Map<string, any>();
    for (const block of comparison.analysis.blocks || []) {
      for (const warning of block.completenessWarnings || []) {
        warnings.set(JSON.stringify(warning), warning);
      }
    }

    return {
      ...base,
      regions: (comparison.analysis.blocks || []).map((block: any) => {
        const part = ordinals.get(block.stablePartKey) || {};
        return {
          blockIndex: block.blockIndex,
          stablePartKey: block.stablePartKey,
          leftPartIndex: part.left,
          rightPartIndex: part.right,
          leftMeasureIndexes: (block.baseMeasureRefs || []).map((ref: any) => ref.measureIndex),
          rightMeasureIndexes: (block.candidateMeasureRefs || []).map(
            (ref: any) => ref.measureIndex
          ),
          differenceClasses: block.differenceClasses || [],
          // How a reader would name this block, and where to draw it on the
          // scan. Both are things only this side knows: the measure labels live
          // on refs the payload does not carry, and the box is meaningless
          // without the system region it is relative to.
          leftMeasureLabel: measureLabel(block.baseMeasureRefs || []),
          rightMeasureLabel: measureLabel(block.candidateMeasureRefs || []),
          cropBoxes: cropBoxesFor(block.blockIndex),
          // Which events inside each bar are unmatched, so a reader is pointed
          // at the note rather than at the bar containing it. Named by side to
          // match the rest of this payload, which speaks left/right rather than
          // base/candidate.
          symbolDifferences: (block.symbolDifferences || []).map((difference: any) => ({
            measurePosition: difference.measurePosition,
            leftMeasureIndex: difference.baseMeasureIndex,
            rightMeasureIndex: difference.candidateMeasureIndex,
            leftEventIndexes: difference.baseEventIndexes,
            rightEventIndexes: difference.candidateEventIndexes,
            leftEventCount: difference.baseEventCount,
            rightEventCount: difference.candidateEventCount
          })),
          // What each side has to give, so a control that would take nothing is
          // never offered.
          leftMarkings: block.baseMarkings,
          rightMarkings: block.candidateMarkings,
          // §7: no decision may be offered for a bar whose comparison is not
          // grounded, and that is enforced structurally rather than by
          // discouragement — a decision route requires this signature, so an
          // ungrounded block simply cannot present one.
          contentSignature: groundedBlockIndexes.has(block.blockIndex)
            ? block.contentSignature
            : undefined,
          grounded: groundedBlockIndexes.has(block.blockIndex)
        };
      }),
      warnings: [...warnings.values()]
    };
  }

  async pageComparison(
    userId: string,
    jobId: string,
    pageNumber: number,
    baseEngineId: string,
    candidateEngineId: string
  ): Promise<any> {
    this.assertAvailable(userId);
    if (
      !isScannerEngineId(baseEngineId) ||
      !isScannerEngineId(candidateEngineId) ||
      baseEngineId === candidateEngineId
    ) {
      throw new BadRequestException('Comparison requires two distinct valid scanner engines');
    }
    const job = await this.ownedJob(userId, jobId);
    const page = job.pages.find((entry) => entry.pageNumber === pageNumber);
    if (!page) throw new NotFoundException('Scanner page not found');
    return {
      ...(await this.pageComparisonForJob(job, page, baseEngineId, candidateEngineId)),
      statusVersion: job.statusVersion || 1
    };
  }

  private async pageComparisonForJob(
    job: ScannerJobDocument,
    page: ScannerPageResult,
    baseEngineId: ScannerEngineId,
    candidateEngineId: ScannerEngineId
  ): Promise<any> {
    // A merged score does not close the comparison: the comparison is where the
    // merge is made and revised, and the engine readings remain the evidence
    // for every bar still under review. Spot review is a different matter — it
    // regenerates an engine's own XML, which a merged score would shadow — so
    // that guard stays where it is.
    const plan = this.enginePlanForJob(job);
    for (const engineId of [baseEngineId, candidateEngineId]) {
      if (!plan.engineIds.includes(engineId)) {
        throw new BadRequestException(`Scanner engine ${engineId} is not part of this job`);
      }
      if (this.registeredEngines && !this.registeredEngines.get(engineId)) {
        throw new BadRequestException(
          `Scanner engine ${engineId} is not registered for comparison`
        );
      }
    }

    const runFor = (engineId: ScannerEngineId): ScannerEngineRun | undefined =>
      page.engines?.[engineId] ||
      (engineId === 'homr'
        ? scannerHomrRun(page, {
            providerRevision: job.providerRevision,
            modelRevision: job.modelRevision,
            provenance: job.engineProvenance
          })
        : undefined);
    const baseRun = runFor(baseEngineId);
    const candidateRun = runFor(candidateEngineId);
    if (baseRun?.status !== 'succeeded' || candidateRun?.status !== 'succeeded') {
      throw new ConflictException('Both selected scanner engines must have successful results');
    }
    const baseArtifact = baseRun.reviewedMusicXml || baseRun.artifacts.musicXml;
    const candidateArtifact = candidateRun.reviewedMusicXml || candidateRun.artifacts.musicXml;
    if (
      !/^[a-f0-9]{64}$/i.test(baseArtifact?.checksumSha256 || '') ||
      !/^[a-f0-9]{64}$/i.test(candidateArtifact?.checksumSha256 || '')
    ) {
      throw new ConflictException('Both selected scanner engine artifacts must be available');
    }

    const pair = { baseEngineId, candidateEngineId };
    const side = (engineId: ScannerEngineId, run: ScannerEngineRun, checksum: string) => ({
      engineId,
      displayName: plan.capabilitySnapshots[engineId].displayName,
      artifactChecksumSha256: checksum,
      completeness: run.completeness,
      unsupportedSemanticClasses:
        plan.capabilitySnapshots[engineId].unsupportedSemanticClasses || []
    });
    if (!page.recognitionRaster || !baseRun.recognitionRaster || !candidateRun.recognitionRaster) {
      return {
        version: SCANNER_PAGE_COMPARISON_VERSION,
        status: 'refused',
        pair,
        base: side(baseEngineId, baseRun, baseArtifact.checksumSha256),
        candidate: side(candidateEngineId, candidateRun, candidateArtifact.checksumSha256),
        refusalReasons: [
          {
            stage: 'prerequisites',
            code: 'recognition-raster-unavailable',
            detail: 'This retained job predates content-bound recognition rasters'
          }
        ]
      };
    }

    const [baseMusicXml, candidateMusicXml] = await Promise.all([
      this.storage.getObjectBuffer(baseArtifact.bucket, baseArtifact.objectKey),
      this.storage.getObjectBuffer(candidateArtifact.bucket, candidateArtifact.objectKey)
    ]);
    const baseDefinition = this.registeredEngines?.get(baseEngineId);
    const candidateDefinition = this.registeredEngines?.get(candidateEngineId);
    const loadRecognitionRaster = () =>
      this.storage.getObjectBuffer(
        page.recognitionRaster!.storage.bucket,
        page.recognitionRaster!.storage.objectKey
      );
    const producerSide = (run: ScannerEngineRun, musicXml: ScannerStorageLocator) => {
      const artifacts = { ...run.artifacts, musicXml };
      return {
        artifacts,
        loadArtifact: async (kind: string): Promise<Buffer | undefined> => {
          const locator = kind === 'musicxml' ? artifacts.musicXml : artifacts[kind];
          return locator
            ? this.storage.getObjectBuffer(locator.bucket, locator.objectKey)
            : undefined;
        },
        loadRecognitionRaster
      };
    };
    return compareScannerPage({
      reportInternalError: (context, error) =>
        this.logger.error(
          `Scanner comparison ${context} for job ${job.jobId} page ${page.pageNumber}: ${
            error instanceof Error ? error.stack || error.message : String(error)
          }`
        ),
      sourceImage: {
        checksumSha256: page.recognitionRaster.checksumSha256,
        width: page.recognitionRaster.width,
        height: page.recognitionRaster.height
      },
      base: {
        ...side(baseEngineId, baseRun, baseArtifact.checksumSha256),
        musicXml: baseMusicXml,
        recognitionRaster: baseRun.recognitionRaster,
        modelRevision: baseRun.modelRevision,
        review: baseRun.review,
        ...producerSide(baseRun, baseArtifact),
        measureGeometryProducer: baseDefinition?.measureGeometryProducer
      },
      candidate: {
        ...side(candidateEngineId, candidateRun, candidateArtifact.checksumSha256),
        musicXml: candidateMusicXml,
        recognitionRaster: candidateRun.recognitionRaster,
        modelRevision: candidateRun.modelRevision,
        review: candidateRun.review,
        ...producerSide(candidateRun, candidateArtifact),
        measureGeometryProducer: candidateDefinition?.measureGeometryProducer
      }
    });
  }

  /** Serve the exact reviewed-or-raw MusicXML revision named by a comparison response. */
  async pageComparisonReading(
    userId: string,
    jobId: string,
    pageNumber: number,
    engineId: string,
    statusVersion: number,
    artifactChecksumSha256: string,
    /**
     * The other side of the pair this reading is being shown against.
     *
     * Needed because a reading is not always served as the engine wrote it: a
     * candidate whose parts were folded onto the base's staves must be served
     * folded, or the pane the reviewer sees would number its bars differently
     * from the blocks drawn over it.
     */
    baseEngineId?: string
  ): Promise<{ body: Buffer; contentType: string }> {
    this.assertAvailable(userId);
    if (!isScannerEngineId(engineId)) {
      throw new BadRequestException('Scanner comparison engine is invalid');
    }
    if (!Number.isInteger(statusVersion) || statusVersion < 1) {
      throw new BadRequestException('Scanner job status version is required');
    }
    if (!/^[a-f0-9]{64}$/i.test(artifactChecksumSha256)) {
      throw new BadRequestException('Scanner comparison artifact checksum is invalid');
    }

    const job = await this.ownedJob(userId, jobId);
    if ((job.statusVersion || 1) !== statusVersion) {
      throw new ConflictException('Scanner comparison changed; refresh and try again');
    }
    const page = job.pages.find((entry) => entry.pageNumber === pageNumber);
    if (!page) throw new NotFoundException('Scanner page not found');
    // Readings stay served once a merge exists; they are the evidence the merge
    // is judged against, and withholding them would leave the merged pane with
    // nothing to compare to.
    const plan = this.enginePlanForJob(job);
    if (!plan.engineIds.includes(engineId)) {
      throw new BadRequestException(`Scanner engine ${engineId} is not part of this job`);
    }
    if (this.registeredEngines && !this.registeredEngines.get(engineId)) {
      throw new BadRequestException(`Scanner engine ${engineId} is not registered for comparison`);
    }
    const run =
      page.engines?.[engineId] ||
      (engineId === 'homr'
        ? scannerHomrRun(page, {
            providerRevision: job.providerRevision,
            modelRevision: job.modelRevision,
            provenance: job.engineProvenance
          })
        : undefined);
    if (run?.status !== 'succeeded') {
      throw new ConflictException('The selected scanner engine has no successful result');
    }
    const artifact = run.reviewedMusicXml || run.artifacts.musicXml;
    if (
      !artifact ||
      artifact.checksumSha256.toLowerCase() !== artifactChecksumSha256.toLowerCase()
    ) {
      throw new ConflictException('Scanner comparison reading changed; refresh and try again');
    }
    const body = await this.storage.getObjectBuffer(artifact.bucket, artifact.objectKey);
    if (createHash('sha256').update(body).digest('hex') !== artifact.checksumSha256.toLowerCase()) {
      throw new ConflictException('Scanner comparison reading changed; refresh and try again');
    }
    if (!baseEngineId || baseEngineId === engineId) {
      return { body, contentType: artifact.contentType };
    }
    if (!isScannerEngineId(baseEngineId) || !plan.engineIds.includes(baseEngineId)) {
      throw new BadRequestException(`Scanner engine ${baseEngineId} is not part of this job`);
    }
    const layout = reconcileScannerPartLayout({
      baseXml: await this.engineMusicXml(page, baseEngineId),
      candidateXml: body
    });
    return { body: layout.musicXml, contentType: artifact.contentType };
  }

  /**
   * What the reviewer has merged for this page, and whether it still answers
   * the readings it was made against.
   *
   * Metadata only; the document itself is served by `pageMergedScoreMusicXml`
   * so a poll for staleness does not drag a whole score across the wire.
   */
  async pageMergedScore(userId: string, jobId: string, pageNumber: number): Promise<any> {
    this.assertAvailable(userId);
    const job = await this.ownedJob(userId, jobId);
    const page = job.pages.find((entry) => entry.pageNumber === pageNumber);
    if (!page) throw new NotFoundException('Scanner page not found');
    return this.mergedScoreState(job, page);
  }

  private mergedScoreState(job: ScannerJobDocument, page: ScannerPageResult): any {
    const basisSignature = scannerMergedScoreBasis(page);
    return {
      pageNumber: page.pageNumber,
      statusVersion: job.statusVersion || 1,
      present: Boolean(page.mergedMusicXml),
      sourceEngineId: page.mergedScore?.sourceEngineId,
      revision: page.mergedScore?.revision ?? 0,
      edited: Boolean(page.mergedScore?.edited),
      updatedAt: page.mergedScore?.updatedAt,
      checksumSha256: page.mergedMusicXml?.checksumSha256,
      sizeBytes: page.mergedMusicXml?.sizeBytes,
      /** Quote this when saving; a mismatch means the readings moved. */
      basisSignature,
      recordedBasisSignature: page.mergedScore?.basisSignature,
      stale: scannerMergedScoreStale(page)
    };
  }

  /** Stream the merged score itself, pinned to the exact revision the caller holds. */
  async pageMergedScoreMusicXml(
    userId: string,
    jobId: string,
    pageNumber: number,
    revision: number
  ): Promise<{ body: Buffer; contentType: string }> {
    this.assertAvailable(userId);
    const job = await this.ownedJob(userId, jobId);
    const page = job.pages.find((entry) => entry.pageNumber === pageNumber);
    if (!page?.mergedMusicXml || !page.mergedScore) {
      throw new NotFoundException('This page has no merged score');
    }
    if (Number.isInteger(revision) && revision !== page.mergedScore.revision) {
      throw new ConflictException('The merged score changed; refresh and try again');
    }
    const artifact = page.mergedMusicXml;
    const body = await this.storage.getObjectBuffer(artifact.bucket, artifact.objectKey);
    if (createHash('sha256').update(body).digest('hex') !== artifact.checksumSha256.toLowerCase()) {
      throw new ConflictException('The merged score changed; refresh and try again');
    }
    return { body, contentType: artifact.contentType };
  }

  /**
   * Save the reviewer's merged reading of a page.
   *
   * Three guards, each for a distinct way this goes wrong:
   *
   * - `revision` is optimistic concurrency for the merged score itself. Two
   *   tabs on the same page must not silently overwrite each other; the job's
   *   `statusVersion` cannot serve here because it also moves for reasons that
   *   have nothing to do with this document.
   * - `basisSignature` binds the save to the readings it was made against. If
   *   an engine re-ran underneath the reviewer, the merge answers a question
   *   that no longer exists, and `acceptStale` is the reviewer saying they know.
   * - The document is validated to exactly the bar provider output is held to,
   *   because from here on it *is* the page (`effectivePageMusicXml`).
   */
  async saveMergedScore(
    userId: string,
    jobId: string,
    pageNumber: number,
    input: {
      musicXml: string;
      sourceEngineId: string;
      basisSignature: string;
      revision: number;
      edited?: boolean;
      acceptStale?: boolean;
    }
  ): Promise<any> {
    this.assertAvailable(userId);
    const job = await this.ownedJob(userId, jobId);
    const page = job.pages.find((entry) => entry.pageNumber === pageNumber);
    if (!page) throw new NotFoundException('Scanner page not found');
    if (page.status !== 'succeeded') {
      throw new ConflictException('Only a succeeded page can carry a merged score');
    }
    if (!isScannerEngineId(input.sourceEngineId)) {
      throw new BadRequestException('A merged score must name the engine it started from');
    }
    const plan = this.enginePlanForJob(job);
    if (!plan.engineIds.includes(input.sourceEngineId)) {
      throw new BadRequestException(
        `Scanner engine ${input.sourceEngineId} is not part of this job`
      );
    }
    if (page.engines?.[input.sourceEngineId]?.status !== 'succeeded') {
      throw new ConflictException('That engine has no successful reading of this page');
    }

    const currentRevision = page.mergedScore?.revision ?? 0;
    if (!Number.isInteger(input.revision) || input.revision !== currentRevision) {
      throw new ConflictException('The merged score changed; refresh and try again');
    }
    const basisSignature = scannerMergedScoreBasis(page);
    if (input.basisSignature !== basisSignature && !input.acceptStale) {
      throw new ConflictException(
        'The engine readings changed since this merge was made; review it before saving'
      );
    }

    const buffer = Buffer.from(input.musicXml ?? '', 'utf8');
    if (buffer.length === 0) throw new BadRequestException('A merged score cannot be empty');
    if (buffer.length > SCANNER_MAX_MERGED_SCORE_BYTES) {
      throw new PayloadTooLargeException('That merged score is too large to store');
    }
    try {
      assertValidMusicXml(buffer);
    } catch {
      // The merged score becomes the page, so a document that would fail
      // assembly must fail here, where the reviewer can still see why.
      throw new BadRequestException('That merged score is not usable MusicXML');
    }

    const mergedScore: ScannerMergedScore = {
      sourceEngineId: input.sourceEngineId,
      basisSignature,
      // Once hand work has landed it stays recorded, because what it marks is
      // that neither engine can be credited for this page — and a later save
      // that happens to touch no bars does not undo that.
      edited: Boolean(input.edited) || Boolean(page.mergedScore?.edited),
      revision: currentRevision + 1,
      decisions: page.mergedScore?.decisions,
      updatedAt: new Date()
    };
    const state = await this.persistMergedScore({
      userId,
      jobId,
      pageNumber,
      job,
      page,
      buffer,
      mergedScore,
      acceptedStale: input.basisSignature !== basisSignature
    });
    // A hand edit is the strongest signal this feature produces and the easiest
    // to file wrongly: "both engines were wrong here, and this is what the page
    // says" beats any choice between them, but only if it is never recorded as
    // one of them having been right. Emitted once, when the edit first lands.
    if (mergedScore.edited && !page.mergedScore?.edited) {
      const plan = this.enginePlanForJob(job);
      const [baseEngineId, candidateEngineId] = plan.engineIds;
      await this.recordMergeDecision({
        page,
        userId,
        baseEngineId: baseEngineId || input.sourceEngineId,
        candidateEngineId: candidateEngineId || input.sourceEngineId,
        outcome: 'edited',
        // An edit is page-level: nothing records which bars it touched, so a
        // consumer weighting per-bar takes on this page needs to know there
        // were some.
        priorDecisions: (page.mergedScore?.decisions || []).length
      });
    }
    return state;
  }

  /**
   * Store a merged score and make it the page.
   *
   * Shared by a reviewer's save and by a bar-level take, because they differ
   * only in how the document was produced: both make it the page's effective
   * MusicXML, both invalidate every derivative built from the old one, and both
   * have to retire the object they replaced.
   */
  private async persistMergedScore(input: {
    userId: string;
    jobId: string;
    pageNumber: number;
    job: ScannerJobDocument;
    page: ScannerPageResult;
    buffer: Buffer;
    mergedScore: ScannerMergedScore;
    acceptedStale?: boolean;
  }): Promise<any> {
    const { userId, jobId, pageNumber, job, page, buffer, mergedScore } = input;
    const contentType = 'application/vnd.recordare.musicxml+xml';
    const stored = await this.storage.putDerivativeObject(
      `scanner/${this.userHash(userId)}/${jobId}/page-${String(pageNumber).padStart(3, '0')}-merged-${randomUUID()}.musicxml`,
      buffer,
      buffer.length,
      contentType
    );
    const locator: ScannerStorageLocator = {
      bucket: stored.bucket,
      objectKey: stored.objectKey,
      sizeBytes: buffer.length,
      contentType,
      checksumSha256: createHash('sha256').update(buffer).digest('hex')
    };
    const updatedPage: ScannerPageResult = { ...page, mergedMusicXml: locator, mergedScore };
    const updatedPages = job.pages.map((entry) =>
      entry.pageNumber === pageNumber ? updatedPage : entry
    );
    const hadCombined = Boolean((job as any).combinedMusicXml || (job as any).combinedPdf);
    const write = await this.jobs
      .updateOne(
        { _id: job._id, statusVersion: job.statusVersion || 1 },
        {
          $set: {
            pages: updatedPages,
            ...(hadCombined ? { combinedStale: true } : {}),
            // The merged score is now this page's effective MusicXML, so every
            // derivative built from the old one describes a page that no longer
            // exists. Same reasoning as a spot correction.
            ...(['succeeded', 'partial'].includes(job.status)
              ? { reassembleRequestedAt: new Date() }
              : {})
          },
          $inc: { statusVersion: 1 }
        }
      )
      .exec();
    if (write?.matchedCount === 0) {
      await this.storage.deleteObject(locator.bucket, locator.objectKey).catch(() => undefined);
      throw new ConflictException('The merged score changed; refresh and try again');
    }

    const superseded = page.mergedMusicXml;
    if (
      superseded &&
      (superseded.bucket !== locator.bucket || superseded.objectKey !== locator.objectKey)
    ) {
      await this.storage
        .deleteObject(superseded.bucket, superseded.objectKey)
        .catch((error) =>
          this.logger.warn(
            `Unable to retire superseded scanner merged score: ${this.messageOf(error)}`
          )
        );
    }

    this.telemetry.emit('merged_score_saved', {
      jobId,
      pageNumber,
      engine: mergedScore.sourceEngineId,
      mergedRevision: mergedScore.revision,
      mergedEdited: mergedScore.edited,
      mergedAcceptedStale: input.acceptedStale
    });

    return this.mergedScoreState(
      { ...job, statusVersion: (job.statusVersion || 1) + 1 } as ScannerJobDocument,
      updatedPage
    );
  }

  /**
   * Take one comparison block from one engine into the page's merged score.
   *
   * S3's atomic act. Everything it needs to refuse is already computed: the
   * block's `contentSignature` binds the decision to both artifact revisions,
   * and §7 makes an ungrounded decision structurally impossible by withholding
   * that signature from any block whose location on the scan could not be
   * proven — so a caller cannot present one for a block it should not decide.
   *
   * The merged score is the base. That matters: the reviewer is building one
   * document, and each take applies to what they have so far rather than to the
   * engine reading it started from, so two takes in different bars compose.
   */
  async takeBlockIntoMergedScore(
    userId: string,
    jobId: string,
    pageNumber: number,
    input: {
      blockIndex: number;
      contentSignature: string;
      engineId: string;
      baseEngineId: string;
      candidateEngineId: string;
      revision: number;
    }
  ): Promise<any> {
    const {
      job,
      page,
      block,
      mergedSourceEngineId,
      map,
      currentRevision
    } = await this.resolveDecisionContext(userId, jobId, pageNumber, input);

    const indexesFor = (engineId: string): number[] =>
      (engineId === input.baseEngineId
        ? block.baseMeasureRefs || []
        : block.candidateMeasureRefs || []
      ).map((ref: any) => ref.measureIndex);

    const baseMeasureIndexes = indexesFor(mergedSourceEngineId);
    const candidateMeasureIndexes = indexesFor(input.engineId);
    if (input.engineId === mergedSourceEngineId) {
      throw new ConflictException(
        'The merged score already reads this passage the way that engine does'
      );
    }
    // A block only one engine read is an insertion or a deletion rather than a
    // replacement, and the anchor is the only thing that says where. It counts
    // base measures, so it is meaningful only when the merged score follows the
    // base reading — which is also the only case its indexes are expressed in.
    const sourceAnchorIndex =
      mergedSourceEngineId === input.baseEngineId ? block.baseAnchorIndex : undefined;
    if (baseMeasureIndexes.length === 0 && sourceAnchorIndex === undefined) {
      throw new ConflictException(
        'This passage can only be inserted into a merged score that follows the base reading'
      );
    }

    const baseXml = await this.mergedOrEngineMusicXml(page, mergedSourceEngineId, input);
    const mergedMeasureIndexes = resolveMergedIndexes(map, baseMeasureIndexes);
    if (!mergedMeasureIndexes) {
      throw new ConflictException(
        'That passage is no longer in the merged score — an earlier decision removed it.'
      );
    }
    const mergedAnchorIndex =
      sourceAnchorIndex === undefined ? undefined : resolveMergedAnchor(map, sourceAnchorIndex);
    if (mergedAnchorIndex === null) {
      throw new ConflictException(
        'The bar this passage would follow is no longer in the merged score, so there is nowhere ' +
          'to put it.'
      );
    }

    const candidateXml = await this.comparisonReadingMusicXml(page, input.engineId, input);
    const outcome = spliceScannerMeasures({
      baseXml,
      candidateXml,
      basePartIndex: 0,
      candidatePartIndex: 0,
      baseMeasureIndexes: mergedMeasureIndexes,
      candidateMeasureIndexes,
      baseAnchorIndex: mergedAnchorIndex
    });
    if (!outcome.musicXml) {
      // Refusals are information, not an error to swallow: the reviewer is
      // told exactly what about this passage cannot be moved.
      throw new ConflictException({
        message: 'This passage cannot be taken from that reading',
        refusals: outcome.refusals,
        violations: outcome.violations
      });
    }

    // Carry the map forward by exactly what the splice did, so the next
    // decision sees this one.
    const nextMap =
      candidateMeasureIndexes.length === 0
        ? withRemovedMeasures(map, mergedMeasureIndexes)
        : mergedMeasureIndexes.length === 0
          ? withInsertedMeasures(map, mergedAnchorIndex ?? -1, candidateMeasureIndexes.length)
          : map;

    const decision: ScannerMergedDecision = {
      blockIndex: input.blockIndex,
      contentSignature: block.contentSignature,
      engineId: input.engineId,
      measureIndexes: mergedMeasureIndexes,
      repairs: outcome.repairs.map((repair) => ({ code: repair.code, detail: repair.detail })),
      decidedAt: new Date()
    };
    const mergedScore: ScannerMergedScore = {
      sourceEngineId: mergedSourceEngineId,
      basisSignature: scannerMergedScoreBasis(page),
      edited: Boolean(page.mergedScore?.edited),
      revision: currentRevision + 1,
      decisions: [...(page.mergedScore?.decisions || []), decision],
      measureMap: nextMap,
      updatedAt: new Date()
    };
    const state = await this.persistMergedScore({
      userId,
      jobId,
      pageNumber,
      job,
      page,
      buffer: outcome.musicXml,
      mergedScore
    });
    await this.recordMergeDecision({
      page,
      userId,
      baseEngineId: input.baseEngineId,
      candidateEngineId: input.candidateEngineId,
      engineId: input.engineId,
      outcome:
        candidateMeasureIndexes.length === 0
          ? 'removed-bars'
          : mergedMeasureIndexes.length === 0
            ? 'inserted-bars'
            : 'took-notes',
      blockIndex: input.blockIndex,
      contentSignature: block.contentSignature,
      differenceClasses: block.differenceClasses,
      repairs: decision.repairs
    });
    return { ...state, decision, repairs: outcome.repairs };
  }

  /**
   * Everything a decision has to establish before it can act.
   *
   * Shared by taking a bar and taking markings because the refusals are the
   * same for both: they differ only in what they then do with the passage. The
   * signature binds the decision to both artifact revisions, the revision stops
   * a second tab overwriting the first, and §7's groundedness rule is enforced
   * here as well as by withholding the signature in the first place.
   */
  private async resolveDecisionContext(
    userId: string,
    jobId: string,
    pageNumber: number,
    input: {
      blockIndex: number;
      contentSignature: string;
      engineId: string;
      baseEngineId: string;
      candidateEngineId: string;
      revision: number;
    }
  ) {
    this.assertAvailable(userId);
    const job = await this.ownedJob(userId, jobId);
    const page = job.pages.find((entry) => entry.pageNumber === pageNumber);
    if (!page) throw new NotFoundException('Scanner page not found');
    if (page.status !== 'succeeded') {
      throw new ConflictException('Only a succeeded page can carry a merged score');
    }
    if (!isScannerEngineId(input.engineId)) {
      throw new BadRequestException('A decision must name the engine it takes from');
    }
    if (input.engineId !== input.baseEngineId && input.engineId !== input.candidateEngineId) {
      throw new BadRequestException('That engine is not one of the two being compared');
    }

    const currentRevision = page.mergedScore?.revision ?? 0;
    if (!Number.isInteger(input.revision) || input.revision !== currentRevision) {
      throw new ConflictException('The merged score changed; refresh and try again');
    }

    const comparison = await this.pageComparisonForJob(
      job,
      page,
      input.baseEngineId,
      input.candidateEngineId
    );
    if (comparison.analysis?.status !== 'succeeded') {
      throw new ConflictException('These readings could not be compared, so nothing can be taken');
    }
    const block = (comparison.analysis.blocks || []).find(
      (entry: any) => entry.blockIndex === input.blockIndex
    );
    if (!block) throw new NotFoundException('That comparison block does not exist');
    if (!input.contentSignature || input.contentSignature !== block.contentSignature) {
      throw new ConflictException('The readings changed since this block was shown; refresh');
    }
    const grounded = (comparison.geometry?.blocks || []).some(
      (entry: any) => entry.status === 'ready' && entry.block.blockIndex === input.blockIndex
    );
    if (!grounded) {
      throw new ConflictException(
        'This difference has no verified place on the scan, so it cannot be decided'
      );
    }

    // The merged score's measure numbering follows whichever engine it started
    // from, so that is the side its indexes are expressed in. The map keeps the
    // two reconciled once a decision has changed the merged score's length.
    const mergedSourceEngineId = page.mergedScore?.sourceEngineId || input.baseEngineId;
    const map =
      page.mergedScore?.measureMap ||
      identityMeasureMap(
        readScannerSpliceFacts(
          await this.mergedOrEngineMusicXml(page, mergedSourceEngineId, input)
        )[0]?.measures.length ?? 0
      );

    return { job, page, block, comparison, mergedSourceEngineId, map, currentRevision };
  }

  /**
   * Take one engine's dynamics and lyrics without taking its notes.
   *
   * §4 calls this the clearest single argument for a purpose-built mode, and it
   * exists because Transcoda declares `lyrics` and `dynamics` unsupported: when
   * its notes are the better reading, everything the other engine heard *about*
   * those notes is only in the other engine. No other comparator in this
   * product has an operation like it, because no other one compares two
   * machines with different blind spots.
   */
  async takeMarkingsIntoMergedScore(
    userId: string,
    jobId: string,
    pageNumber: number,
    input: {
      blockIndex: number;
      contentSignature: string;
      engineId: string;
      baseEngineId: string;
      candidateEngineId: string;
      revision: number;
      kind: 'dynamics' | 'lyrics';
    }
  ): Promise<any> {
    if (input.kind !== 'dynamics' && input.kind !== 'lyrics') {
      throw new BadRequestException('A marking decision must say whether it takes dynamics or lyrics');
    }
    const decided = await this.resolveDecisionContext(userId, jobId, pageNumber, input);
    const { job, page, block, mergedSourceEngineId, map, currentRevision } = decided;

    const indexesFor = (engineId: string): number[] =>
      (engineId === input.baseEngineId
        ? block.baseMeasureRefs || []
        : block.candidateMeasureRefs || []
      ).map((ref: any) => ref.measureIndex);
    const mergedMeasureIndexes = resolveMergedIndexes(map, indexesFor(mergedSourceEngineId));
    if (!mergedMeasureIndexes) {
      throw new ConflictException(
        'That passage is no longer in the merged score — an earlier decision removed it.'
      );
    }

    const baseXml = await this.mergedOrEngineMusicXml(page, mergedSourceEngineId, input);
    const candidateXml = await this.comparisonReadingMusicXml(page, input.engineId, input);
    const outcome = transferScannerMarkings({
      baseXml,
      candidateXml,
      basePartIndex: 0,
      candidatePartIndex: 0,
      baseMeasureIndexes: mergedMeasureIndexes,
      candidateMeasureIndexes: indexesFor(input.engineId),
      kind: input.kind
    });
    if (!outcome.musicXml) {
      throw new ConflictException({
        message: `Those ${input.kind} cannot be taken onto this passage`,
        refusals: outcome.refusals,
        violations: outcome.violations
      });
    }

    const decision: ScannerMergedDecision = {
      blockIndex: input.blockIndex,
      contentSignature: block.contentSignature,
      engineId: input.engineId,
      measureIndexes: mergedMeasureIndexes,
      // Recorded distinctly from a bar take: phase E must not read "HOMR was
      // right here" from a decision that only moved a dynamic.
      markingsOnly: input.kind,
      decidedAt: new Date()
    };
    const mergedScore: ScannerMergedScore = {
      sourceEngineId: mergedSourceEngineId,
      basisSignature: scannerMergedScoreBasis(page),
      edited: Boolean(page.mergedScore?.edited),
      revision: currentRevision + 1,
      decisions: [...(page.mergedScore?.decisions || []), decision],
      measureMap: page.mergedScore?.measureMap,
      updatedAt: new Date()
    };
    const state = await this.persistMergedScore({
      userId,
      jobId,
      pageNumber,
      job,
      page,
      buffer: outcome.musicXml,
      mergedScore
    });
    await this.recordMergeDecision({
      page,
      userId,
      baseEngineId: input.baseEngineId,
      candidateEngineId: input.candidateEngineId,
      engineId: input.engineId,
      // Distinct from a note win: the notes these markings sit over came from
      // somewhere else, and may have come from the engine that lost.
      outcome: input.kind === 'lyrics' ? 'took-lyrics' : 'took-dynamics',
      blockIndex: input.blockIndex,
      contentSignature: block.contentSignature,
      differenceClasses: block.differenceClasses
    });
    return { ...state, decision, transferred: outcome.transferred };
  }

  /**
   * Keep what a reviewer decided, for training.
   *
   * A comparison produces a kind of signal spot review cannot: a correction
   * says the model was unsure and here is the right answer; this says two
   * independent readings disagreed and here is which one a human believed. That
   * is a labelled preference over the exact page both engines saw, and the only
   * place in the product where one exists.
   *
   * Best-effort, like a correction: a training record that fails to write must
   * never fail the decision the reviewer just made.
   */
  private async recordMergeDecision(input: {
    page: ScannerPageResult;
    userId: string;
    baseEngineId: string;
    candidateEngineId: string;
    outcome: ScannerMergeOutcome;
    engineId?: string;
    blockIndex?: number;
    contentSignature?: string;
    differenceClasses?: string[];
    repairs?: Array<{ code: string; detail: string }>;
    priorDecisions?: number;
  }): Promise<void> {
    if (!this.mergeDecisions) return;
    try {
      const pageSha256 = input.page.recognitionRaster?.storage?.checksumSha256
        || input.page.sourceImage?.checksumSha256;
      if (!pageSha256) return;
      const artifactOf = (engineId: string) => {
        const run = input.page.engines?.[engineId];
        return run?.reviewedMusicXml?.checksumSha256 || run?.artifacts?.musicXml?.checksumSha256;
      };
      const revisionsOf = (engineId: string) => {
        const run = input.page.engines?.[engineId];
        return { modelRevision: run?.modelRevision, providerRevision: run?.providerRevision };
      };
      await this.mergeDecisions.create({
        pageSha256,
        userHash: this.telemetry.userHash(input.userId),
        baseEngineId: input.baseEngineId,
        candidateEngineId: input.candidateEngineId,
        // The invariant, in the one place it can be enforced: an edited bar is
        // evidence that *both* engines were wrong there, so no engine is
        // credited for it however it is called.
        ...(input.outcome === 'edited' || !input.engineId ? {} : { engineId: input.engineId }),
        outcome: input.outcome,
        blockIndex: input.blockIndex,
        contentSignature: input.contentSignature,
        differenceClasses: input.differenceClasses || [],
        baseArtifactSha256: artifactOf(input.baseEngineId),
        candidateArtifactSha256: artifactOf(input.candidateEngineId),
        engineRevisions: {
          [input.baseEngineId]: revisionsOf(input.baseEngineId),
          [input.candidateEngineId]: revisionsOf(input.candidateEngineId)
        },
        repairs: input.repairs || [],
        priorDecisions: input.priorDecisions,
        policyVersion: this.config.get<string>('SCANNER_TRAINING_POLICY_VERSION', 'unset')
      });
    } catch (error) {
      this.logger.warn(
        `Scanner merge decision not recorded for training: ${this.messageOf(error)}`
      );
    }
  }

  /** The merged score when there is one, otherwise the engine it would start from. */
  private async mergedOrEngineMusicXml(
    page: ScannerPageResult,
    engineId: string,
    pair?: { baseEngineId: string; candidateEngineId: string }
  ): Promise<Buffer> {
    if (page.mergedMusicXml && !scannerMergedScoreStale(page)) {
      return this.storage.getObjectBuffer(
        page.mergedMusicXml.bucket,
        page.mergedMusicXml.objectKey
      );
    }
    return pair
      ? this.comparisonReadingMusicXml(page, engineId, pair)
      : this.engineMusicXml(page, engineId);
  }

  /**
   * One engine's reading as the comparison saw it, not as it was stored.
   *
   * When the two engines wrote the same keyboard page with different numbers
   * of parts, the comparison folded the candidate onto the base's staves before
   * aligning anything — so every measure index a block quotes counts measures
   * in that folded document. Splicing from the stored file instead would take
   * the right index out of the wrong document, which is worse than refusing.
   *
   * Deterministic and derived, so this recomputes rather than storing a second
   * artifact: the same two readings always fold the same way.
   */
  private async comparisonReadingMusicXml(
    page: ScannerPageResult,
    engineId: string,
    pair: { baseEngineId: string; candidateEngineId: string }
  ): Promise<Buffer> {
    const musicXml = await this.engineMusicXml(page, engineId);
    if (engineId !== pair.candidateEngineId || pair.baseEngineId === pair.candidateEngineId) {
      return musicXml;
    }
    return reconcileScannerPartLayout({
      baseXml: await this.engineMusicXml(page, pair.baseEngineId),
      candidateXml: musicXml
    }).musicXml;
  }

  /** One engine's reading of a page: reviewed when it exists, raw otherwise. */
  private async engineMusicXml(page: ScannerPageResult, engineId: string): Promise<Buffer> {
    const run = page.engines?.[engineId];
    const artifact = run?.reviewedMusicXml || run?.artifacts?.musicXml;
    if (run?.status !== 'succeeded' || !artifact) {
      throw new ConflictException(`Scanner engine ${engineId} has no usable reading of this page`);
    }
    return this.storage.getObjectBuffer(artifact.bucket, artifact.objectKey);
  }

  /**
   * Discard a merged score, returning the page to its engine readings.
   *
   * Only ever the reviewer's explicit act. Nothing else in the system removes a
   * merged score — a re-run marks it stale and leaves it (§3.1).
   */
  async discardMergedScore(
    userId: string,
    jobId: string,
    pageNumber: number,
    revision: number
  ): Promise<any> {
    this.assertAvailable(userId);
    const job = await this.ownedJob(userId, jobId);
    const page = job.pages.find((entry) => entry.pageNumber === pageNumber);
    if (!page) throw new NotFoundException('Scanner page not found');
    if (!page.mergedMusicXml || !page.mergedScore) {
      throw new NotFoundException('This page has no merged score');
    }
    if (!Number.isInteger(revision) || revision !== page.mergedScore.revision) {
      throw new ConflictException('The merged score changed; refresh and try again');
    }
    const discarded = page.mergedMusicXml;
    const updatedPage: ScannerPageResult = {
      ...page,
      mergedMusicXml: undefined,
      mergedScore: undefined
    };
    const updatedPages = job.pages.map((entry) =>
      entry.pageNumber === pageNumber ? updatedPage : entry
    );
    const hadCombined = Boolean((job as any).combinedMusicXml || (job as any).combinedPdf);
    const write = await this.jobs
      .updateOne(
        { _id: job._id, statusVersion: job.statusVersion || 1 },
        {
          $set: {
            pages: updatedPages,
            ...(hadCombined ? { combinedStale: true } : {}),
            ...(['succeeded', 'partial'].includes(job.status)
              ? { reassembleRequestedAt: new Date() }
              : {})
          },
          $inc: { statusVersion: 1 }
        }
      )
      .exec();
    if (write?.matchedCount === 0) {
      throw new ConflictException('The merged score changed; refresh and try again');
    }
    await this.storage
      .deleteObject(discarded.bucket, discarded.objectKey)
      .catch((error) =>
        this.logger.warn(`Unable to delete discarded scanner merged score: ${this.messageOf(error)}`)
      );
    this.telemetry.emit('merged_score_discarded', {
      jobId,
      pageNumber,
      engine: page.mergedScore.sourceEngineId,
      mergedRevision: revision
    });
    return this.mergedScoreState(
      { ...job, statusVersion: (job.statusVersion || 1) + 1 } as ScannerJobDocument,
      updatedPage
    );
  }

  /** Render the exact evidence crop for one current, grounded comparison block. */
  async pageComparisonBlockCrop(
    userId: string,
    jobId: string,
    pageNumber: number,
    blockIndex: number,
    baseEngineId: string,
    candidateEngineId: string,
    statusVersion: number,
    contentSignature: string,
    geometrySignature: string
  ): Promise<{ body: Buffer; contentType: 'image/png' }> {
    this.assertAvailable(userId);
    if (
      !isScannerEngineId(baseEngineId) ||
      !isScannerEngineId(candidateEngineId) ||
      baseEngineId === candidateEngineId
    ) {
      throw new BadRequestException('Comparison requires two distinct valid scanner engines');
    }
    if (!Number.isInteger(blockIndex) || blockIndex < 0) {
      throw new BadRequestException('Comparison block index is invalid');
    }
    if (!Number.isInteger(statusVersion) || statusVersion < 1) {
      throw new BadRequestException('Scanner job status version is required');
    }
    if (
      !new RegExp(`^${SCANNER_BLOCK_CONTENT_SIGNATURE_VERSION}:[a-f0-9]{64}$`).test(
        contentSignature
      ) ||
      !new RegExp(`^${SCANNER_MEASURE_GEOMETRY_VERSION}:[a-f0-9]{64}$`).test(geometrySignature)
    ) {
      throw new BadRequestException('Comparison crop signatures are invalid');
    }

    const job = await this.ownedJob(userId, jobId);
    if ((job.statusVersion || 1) !== statusVersion) {
      throw new ConflictException('Scanner comparison changed; refresh and try again');
    }
    const page = job.pages.find((entry) => entry.pageNumber === pageNumber);
    if (!page) throw new NotFoundException('Scanner page not found');
    const comparison = await this.pageComparisonForJob(job, page, baseEngineId, candidateEngineId);
    // A page can be only partially grounded: conservative alignment may prove
    // image evidence for some blocks while correctly refusing ambiguous spans.
    // Phase C is read-only, so serve an individually-ready block without
    // pretending the whole page is safe for reconciliation.
    if (!comparison.geometry?.geometrySignature || !Array.isArray(comparison.geometry.blocks)) {
      throw new ConflictException('This comparison block has no verified image evidence');
    }
    if (comparison.geometry.geometrySignature !== geometrySignature) {
      throw new ConflictException('Scanner comparison geometry changed; refresh and try again');
    }
    const blockResult = comparison.geometry.blocks.find(
      (entry: any) => entry.block.blockIndex === blockIndex
    );
    if (!blockResult || blockResult.status !== 'ready') {
      throw new NotFoundException('Scanner comparison block crop is not available');
    }
    if (blockResult.block.contentSignature !== contentSignature) {
      throw new ConflictException('Scanner comparison block changed; refresh and try again');
    }
    if (!page.recognitionRaster?.storage || !comparison.sourceImage) {
      throw new NotFoundException('Scanner recognition raster is not available');
    }

    const source = await this.storage.getObjectBuffer(
      page.recognitionRaster.storage.bucket,
      page.recognitionRaster.storage.objectKey
    );
    return {
      body: await this.renderComparisonBlockCrop(
        source,
        comparison.sourceImage,
        blockResult.block.cropRegions
      ),
      contentType: 'image/png'
    };
  }

  /**
   * The scan of one physical system, for a row-per-system view.
   *
   * Bound to the job's status version so a page that moves on cannot be
   * reviewed against a stale image, and verified against the retained
   * recognition raster exactly as the block crop is. No content signature: a
   * system is a property of the scan, not of any comparison block, and it stays
   * valid while the engines' readings change.
   */
  async pageComparisonSystemCrop(
    userId: string,
    jobId: string,
    pageNumber: number,
    systemIndex: number,
    baseEngineId: string,
    candidateEngineId: string,
    statusVersion: number
  ): Promise<{ body: Buffer; contentType: 'image/png' }> {
    this.assertAvailable(userId);
    if (
      !isScannerEngineId(baseEngineId) ||
      !isScannerEngineId(candidateEngineId) ||
      baseEngineId === candidateEngineId
    ) {
      throw new BadRequestException('Comparison requires two distinct valid scanner engines');
    }
    if (!Number.isInteger(systemIndex) || systemIndex < 0) {
      throw new BadRequestException('Comparison system index is invalid');
    }
    if (!Number.isInteger(statusVersion) || statusVersion < 1) {
      throw new BadRequestException('Scanner job status version is required');
    }

    const job = await this.ownedJob(userId, jobId);
    if ((job.statusVersion || 1) !== statusVersion) {
      throw new ConflictException('Scanner comparison changed; refresh and try again');
    }
    const page = job.pages.find((entry) => entry.pageNumber === pageNumber);
    if (!page) throw new NotFoundException('Scanner page not found');
    const comparison = await this.pageComparisonForJob(job, page, baseEngineId, candidateEngineId);
    const system = (comparison.systems || []).find(
      (entry: any) => entry.systemIndex === systemIndex
    );
    if (!system) throw new NotFoundException('Scanner comparison system is not available');
    if (!page.recognitionRaster?.storage || !comparison.sourceImage) {
      throw new NotFoundException('Scanner recognition raster is not available');
    }

    const source = await this.storage.getObjectBuffer(
      page.recognitionRaster.storage.bucket,
      page.recognitionRaster.storage.objectKey
    );
    return {
      body: await this.renderComparisonBlockCrop(source, comparison.sourceImage, [
        { systemIndex: system.systemIndex, staffIndices: [], region: system.region }
      ]),
      contentType: 'image/png'
    };
  }

  private async renderComparisonBlockCrop(
    source: Buffer,
    expectedIdentity: ScannerRasterIdentity,
    cropRegions: ScannerMeasureCropRegion[]
  ): Promise<Buffer> {
    const metadata = await sharp(source).metadata();
    const actualIdentity = {
      checksumSha256: createHash('sha256').update(source).digest('hex'),
      width: Number(metadata.width || 0),
      height: Number(metadata.height || 0)
    };
    if (
      actualIdentity.checksumSha256 !== expectedIdentity.checksumSha256 ||
      actualIdentity.width !== expectedIdentity.width ||
      actualIdentity.height !== expectedIdentity.height
    ) {
      throw new ConflictException('Scanner recognition raster changed; refresh and try again');
    }
    const rects = comparisonCropRects(cropRegions, actualIdentity);
    if (rects.length === 0) {
      throw new NotFoundException('Scanner comparison block crop is not available');
    }
    if (rects.length > MAX_SCANNER_COMPARISON_CROP_SYSTEMS) {
      throw new PayloadTooLargeException('Scanner comparison block spans too many systems');
    }
    const width = Math.max(...rects.map((rect) => rect.width));
    const height =
      rects.reduce((total, rect) => total + rect.height, 0) +
      SCANNER_COMPARISON_CROP_GUTTER * (rects.length - 1);
    if (width * height > MAX_SCANNER_COMPARISON_CROP_PIXELS) {
      throw new PayloadTooLargeException('Scanner comparison block crop is too large');
    }

    const pieces: Array<{ input: Buffer; left: number; top: number }> = [];
    let top = 0;
    for (const rect of rects) {
      const body = await sharp(source).extract(rect).png().toBuffer();
      pieces.push({ input: body, left: Math.floor((width - rect.width) / 2), top });
      top += rect.height + SCANNER_COMPARISON_CROP_GUTTER;
    }
    return pieces.length === 1
      ? pieces[0].input
      : await sharp({
          create: { width, height, channels: 3, background: '#f3f4f6' }
        })
          .composite(pieces)
          .png()
          .toBuffer();
  }

  /**
   * Apply a reviewer's choice to one spot and rebuild the page's MusicXML.
   *
   * The correction edits the decoded token, not the XML: a rhythm change
   * cascades through the rest of the measure, and only re-generating from
   * symbols keeps the result internally consistent. It also records what the
   * model predicted and what was offered, which is the training signal — a
   * confirmation of a low-confidence prediction is as useful as a change.
   */
  async applyCorrection(
    userId: string,
    jobId: string,
    pageNumber: number,
    spotId: number,
    chosen: string,
    engineId: string,
    contentSignature: string
  ): Promise<any> {
    this.assertAvailable(userId);
    const job = await this.ownedJob(userId, jobId);
    const page = job.pages.find((entry) => entry.pageNumber === pageNumber);
    if (!page) throw new NotFoundException('Scanner page not found');
    if (page.mergedMusicXml) {
      throw new ConflictException('Spot review is unavailable after engine reconciliation');
    }
    if (!engineId) throw new BadRequestException('Scanner engine is required');
    const reviewEngine = this.reviewEngineForPage(job, page, engineId);
    const expectedSignature = scannerEngineReviewContentSignature(reviewEngine.run);
    if (!contentSignature || contentSignature !== expectedSignature) {
      throw new ConflictException('Scanner review content changed; refresh and try again');
    }
    const staves = reviewEngine.run.review?.staves || [];
    const spots = selectSpots(staves, this.reviewThresholds());
    const spot = spots[spotId];
    if (!spot) throw new NotFoundException('Scanner review spot not found');

    const offered = [spot.chosen, ...spot.alternatives.map((entry) => entry.value)];
    if (!offered.includes(chosen)) {
      // Only the model's own alternatives are accepted. Anything else is a
      // different edit entirely and belongs in the Score Editor, where it can
      // be seen in context.
      throw new BadRequestException('That is not one of the offered alternatives');
    }

    const staff = staves.find((entry: any) => entry.index === spot.staffIndex);
    const token = staff?.tokens?.[spot.symbolIndex];
    if (!token) throw new ConflictException('This page has no token sequence to correct');
    const field = TOKEN_FIELDS.indexOf(spot.head);
    if (field < 0) throw new BadRequestException('That symbol cannot be corrected');

    // The edit is folded back into the stored sequence, so corrections
    // accumulate. Regenerating from the *original* tokens each time and keeping
    // only the latest edit silently discarded every earlier correction — and
    // even a later confirmation would erase one, because it regenerates too.
    const editedStaves = staves.map((entry: any) => {
      if (entry.index !== spot.staffIndex) return entry;
      const tokens = (entry.tokens || []).map((row: string[]) => [...row]);
      if (tokens[spot.symbolIndex]) tokens[spot.symbolIndex][field] = chosen;
      return { ...entry, tokens };
    });

    const regenerate =
      reviewEngine.adapter?.regenerateReview?.bind(reviewEngine.adapter) ||
      (reviewEngine.engineId === 'homr' ? this.provider.regenerate.bind(this.provider) : undefined);
    if (!regenerate) {
      throw new ConflictException('This scanner engine cannot regenerate reviewed MusicXML');
    }
    let regenerationInput = editedStaves.map((entry: any) => entry.tokens || []);
    if (reviewEngine.engineId === 'homr') {
      const homrVoices = homrReviewVoicesForRegeneration(editedStaves);
      if (!homrVoices) {
        throw new ConflictException(
          'This review cannot be regenerated safely; rescan the page and try again'
        );
      }
      regenerationInput = homrVoices;
    }
    const musicXmlBuffer = await regenerate(regenerationInput);
    const reviewedContentType = 'application/vnd.recordare.musicxml+xml';
    const storedReviewed = await this.storage.putDerivativeObject(
      `scanner/${this.userHash(userId)}/${jobId}/page-${String(pageNumber).padStart(3, '0')}-${reviewEngine.engineId}-reviewed-${randomUUID()}.musicxml`,
      musicXmlBuffer,
      musicXmlBuffer.length,
      reviewedContentType
    );
    const locator: ScannerStorageLocator = {
      bucket: storedReviewed.bucket,
      objectKey: storedReviewed.objectKey,
      sizeBytes: musicXmlBuffer.length,
      contentType: reviewedContentType,
      checksumSha256: createHash('sha256').update(musicXmlBuffer).digest('hex')
    };

    const outcome: 'confirmed' | 'corrected' = chosen === spot.chosen ? 'confirmed' : 'corrected';
    const correction = {
      spotId,
      head: spot.head,
      predicted: spot.chosen,
      predictedConfidence: spot.confidence,
      offered: spot.alternatives,
      chosen,
      // Both are signal: confirming a 61% prediction says the model was right
      // but unsure, which is exactly what improves calibration.
      outcome,
      contentSignature: expectedSignature,
      correctedAt: new Date()
    };
    const updatedRun: ScannerEngineRun = {
      ...reviewEngine.run,
      review: { staves: editedStaves },
      reviewedMusicXml: locator,
      corrections: [...(reviewEngine.run.corrections || []), correction]
    };
    const updatedPage = withScannerEngineRun(page, updatedRun);
    const updatedPages = job.pages.map((entry) =>
      entry.pageNumber === pageNumber ? updatedPage : entry
    );
    const hadCombined = Boolean((job as any).combinedMusicXml || (job as any).combinedPdf);
    const write = await this.jobs
      .updateOne(
        { _id: job._id, statusVersion: job.statusVersion || 1 },
        {
          $set: {
            pages: updatedPages,
            ...(hadCombined ? { combinedStale: true } : {}),
            // The reviewed page invalidates this page's PDF and everything
            // assembled from it. Reads already refuse to serve those stale, so
            // without this the reviewer's correction simply removes their
            // download. Ask the worker to rebuild rather than leaving them to
            // notice and ask.
            ...(['succeeded', 'partial'].includes(job.status)
              ? { reassembleRequestedAt: new Date() }
              : {})
          },
          $inc: { statusVersion: 1 }
        }
      )
      .exec();
    if (write?.matchedCount === 0) {
      await this.storage.deleteObject(locator.bucket, locator.objectKey).catch(() => undefined);
      throw new ConflictException('Scanner review content changed; refresh and try again');
    }
    const previousReviewed = reviewEngine.run.reviewedMusicXml;
    if (
      previousReviewed &&
      (previousReviewed.bucket !== locator.bucket ||
        previousReviewed.objectKey !== locator.objectKey)
    ) {
      await this.storage
        .deleteObject(previousReviewed.bucket, previousReviewed.objectKey)
        .catch((error) =>
          this.logger.warn(
            `Unable to retire superseded scanner review artifact: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        );
    }

    // Durable training record, deliberately outside the job: jobs and their
    // artifacts expire, and a page reviewed without this is training data
    // destroyed. Keyed on the image hash so a re-scan joins the same history.
    // Best effort — losing a training sample must never fail the correction the
    // reviewer just made.
    try {
      await this.corrections.create({
        pageSha256:
          reviewEngine.run.recognitionRaster?.checksumSha256 ||
          page.recognitionRaster?.checksumSha256 ||
          page.sourceImage?.checksumSha256 ||
          '',
        userHash: this.userHash(userId),
        engineId: reviewEngine.engineId,
        staffIndex: spot.staffIndex,
        symbolIndex: spot.symbolIndex,
        head: spot.head,
        predicted: spot.chosen,
        predictedConfidence: spot.confidence,
        offered: spot.alternatives,
        chosen,
        outcome: correction.outcome,
        modelRevision:
          reviewEngine.run.modelRevision ||
          (reviewEngine.engineId === 'homr'
            ? this.config.get<string>('SCANNER_EXPECTED_HOMR_COMMIT', '')
            : '') ||
          'unknown',
        ...(reviewEngine.engineId === 'homr'
          ? {
              homrRevision:
                reviewEngine.run.modelRevision ||
                this.config.get<string>('SCANNER_EXPECTED_HOMR_COMMIT', '') ||
                'unknown'
            }
          : {}),
        providerRevision:
          reviewEngine.run.providerRevision ||
          (reviewEngine.engineId === 'homr'
            ? this.config.get<string>('SCANNER_EXPECTED_PROVIDER_REVISION', '')
            : '') ||
          'unknown',
        contentSignature: expectedSignature,
        // Which published terms were in force. A scan uploaded under a promise
        // of no training use must not become training data because the Legal
        // page changed later, and only the version at capture time can tell
        // those apart afterwards.
        policyVersion: this.config.get<string>('SCANNER_TRAINING_POLICY_VERSION', 'unset')
      });
    } catch (error) {
      this.logger.warn(
        `Scanner correction not recorded for training: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    // A combined score built before this correction no longer reflects the
    // page. Keep its locator solely so expiry/deletion can collect the object,
    // but mark it stale so no artifact route or UI offers it as current.
    return {
      ok: true,
      outcome: correction.outcome,
      combinedStale: hadCombined,
      engineId: reviewEngine.engineId,
      contentSignature: scannerEngineReviewContentSignature(updatedRun)
    };
  }

  /**
   * Export captured corrections for training, newest first.
   *
   * Admin-only and filterable by policy version, because that is the axis that
   * decides what may lawfully be used: samples captured while the published
   * terms promised no training use must be excluded, not silently swept in.
   */
  /**
   * Merge decisions for training.
   *
   * Alongside `exportCorrections` rather than merged into it, because they are
   * different kinds of sample: a correction is a labelled answer to an uncertain
   * symbol, and this is a labelled preference between two whole readings of the
   * same page. A consumer wants to weight them differently, which it can only do
   * if they arrive apart.
   */
  async exportMergeDecisions(options: {
    policyVersion?: string;
    since?: Date;
    limit?: number;
    outcome?: string;
  }): Promise<any[]> {
    if (!this.mergeDecisions) return [];
    const filter: Record<string, unknown> = {};
    if (options.policyVersion) filter.policyVersion = options.policyVersion;
    if (options.outcome) filter.outcome = options.outcome;
    if (options.since) filter.createdAt = { $gte: options.since };
    return this.mergeDecisions
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.min(Math.max(options.limit || 1000, 1), 10_000))
      .lean()
      .exec();
  }

  async exportCorrections(options: {
    policyVersion?: string;
    since?: Date;
    limit?: number;
  }): Promise<any[]> {
    const filter: Record<string, unknown> = {};
    if (options.policyVersion) filter.policyVersion = options.policyVersion;
    if (options.since) filter.createdAt = { $gte: options.since };
    return this.corrections
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.min(Math.max(options.limit || 1000, 1), 10_000))
      .lean()
      .exec();
  }

  /** A cropped view of the source page behind one spot. */
  async pageCrop(
    userId: string,
    jobId: string,
    pageNumber: number,
    spotId: number,
    level: CropLevel,
    engineId: string,
    contentSignature: string
  ): Promise<{ body: Buffer; contentType: string }> {
    this.assertAvailable(userId);
    const job = await this.ownedJob(userId, jobId);
    const page = job.pages.find((entry) => entry.pageNumber === pageNumber);
    if (!page) throw new NotFoundException('Scanner page image is not available');
    if (page.mergedMusicXml) {
      throw new ConflictException('Spot review is unavailable after engine reconciliation');
    }
    if (!engineId) throw new BadRequestException('Scanner engine is required');

    const reviewEngine = this.reviewEngineForPage(job, page, engineId);
    if (
      !contentSignature ||
      contentSignature !== scannerEngineReviewContentSignature(reviewEngine.run)
    ) {
      throw new ConflictException('Scanner review content changed; refresh and try again');
    }
    const staves = reviewEngine.run.review?.staves || [];
    const spots = selectSpots(staves, this.reviewThresholds());
    const spot = spots[spotId];
    if (!spot) throw new NotFoundException('Scanner review spot not found');
    const staff = staves.find((entry: any) => entry.index === spot.staffIndex);

    const runRaster = reviewEngine.run.recognitionRaster;
    const pageRaster = page.recognitionRaster;
    if (runRaster && !pageRaster) {
      throw new NotFoundException('Scanner page image is not available');
    }
    if (
      runRaster &&
      pageRaster &&
      (runRaster.checksumSha256 !== pageRaster.checksumSha256 ||
        runRaster.width !== pageRaster.width ||
        runRaster.height !== pageRaster.height)
    ) {
      throw new ConflictException('Scanner recognition raster changed; refresh and try again');
    }
    const sourceLocator = runRaster ? pageRaster?.storage : page.sourceImage;
    if (!sourceLocator) throw new NotFoundException('Scanner page image is not available');
    const source = await this.storage.getObjectBuffer(
      sourceLocator.bucket,
      sourceLocator.objectKey
    );
    const image = sharp(source);
    const metadata = await image.metadata();
    const bounds = { width: metadata.width || 0, height: metadata.height || 0 };
    if (!bounds.width || !bounds.height) {
      throw new NotFoundException('Scanner page image could not be read');
    }
    // The staves either side, so `context` can grow vertically into them.
    const neighbours = [spot.staffIndex - 1, spot.staffIndex + 1]
      .map((index) => staves.find((entry: any) => entry.index === index)?.region)
      .filter(Boolean);
    const rect = cropForLevel(level, staff?.region, bounds, neighbours);
    const body = await sharp(source).extract(rect).png().toBuffer();
    return { body, contentType: 'image/png' };
  }

  private float(key: string, fallback: number): number {
    const parsed = Number(this.config.get<string>(key, String(fallback)));
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
  }

  private reviewThresholds() {
    return {
      floor: this.float('SCANNER_REVIEW_CONFIDENCE_FLOOR', DEFAULT_REVIEW_THRESHOLDS.floor),
      lowImpactFloor: this.float(
        'SCANNER_REVIEW_LOW_IMPACT_FLOOR',
        DEFAULT_REVIEW_THRESHOLDS.lowImpactFloor
      ),
      minAlternativeRatio: this.float(
        'SCANNER_REVIEW_MIN_ALTERNATIVE_RATIO',
        DEFAULT_REVIEW_THRESHOLDS.minAlternativeRatio
      ),
      minimum: this.float('SCANNER_REVIEW_CONFIDENCE_MIN', DEFAULT_REVIEW_THRESHOLDS.minimum)
    };
  }

  private async ownedJob(userId: string, jobId: string): Promise<ScannerJobDocument> {
    const job = await this.jobs.findOne({ userId, jobId }).exec();
    if (!job) throw new NotFoundException('Scanner job not found');
    return job;
  }

  private present(job: ScannerJobDocument): any {
    const superseded = job.pages.some((page) => pageMusicXmlSuperseded(page));
    const legacyJobInvalidated = superseded || Boolean(job.combinedStale);
    const enginePlan = this.enginePlanForJob(job);
    return {
      jobId: job.jobId,
      status: job.status,
      statusVersion: job.statusVersion || 1,
      originalFilename: job.originalFilename,
      pageCount: job.pageCount,
      includedPageCount: job.pages.filter((page) => page.included !== false).length,
      /** Only meaningful while `preparing`; absent once the pages exist. */
      preparedPageCount: job.status === 'preparing' ? job.preparedPageCount || 0 : undefined,
      options: job.options,
      enginePlan,
      pages: [...job.pages]
        .sort(
          (left, right) => (left.ordinal || left.pageNumber) - (right.ordinal || right.pageNumber)
        )
        .map((page) => {
          const homr = scannerHomrRun(page, {
            providerRevision: job.providerRevision,
            modelRevision: job.modelRevision,
            provenance: job.engineProvenance
          });
          const effectiveMusicXml = effectivePageMusicXmlSelection(page, enginePlan);
          return {
            pageNumber: page.pageNumber,
            ordinal: page.ordinal || page.pageNumber,
            rotationDegrees: page.rotationDegrees || 0,
            included: page.included !== false,
            status:
              job.status === 'cancelled' && ['pending', 'running'].includes(page.status)
                ? 'cancelled'
                : page.status,
            attempts: page.attempts,
            manualRetries: page.manualRetries || 0,
            errorCode: page.errorCode,
            errorMessage: page.errorMessage,
            hasThumbnail: Boolean(page.thumbnail),
            hasMusicXml: Boolean(effectiveMusicXml),
            effectiveEngineId: effectiveMusicXml?.engineId,
            /** A reviewer has reconciled this page; it is what assembly uses. */
            hasMergedScore: Boolean(page.mergedMusicXml && !scannerMergedScoreStale(page)),
            mergedDecisionCount: (page.mergedScore?.decisions || []).length,
            hasPdf: this.materializedArtifactIsCurrent(
              page.pdf,
              SCANNER_ARTIFACT_BUILDERS.pagePdf,
              [page],
              pageMusicXmlSuperseded(page)
            ),
            engines: Object.fromEntries(
              enginePlan.engineIds.flatMap((engineId) => {
                const run = engineId === 'homr' ? homr : page.engines?.[engineId];
                return run ? [[engineId, this.presentEngineRun(run)]] : [];
              })
            ),
            canRetry: this.pageRetryEligibility(job, page.pageNumber, page).allowed
          };
        }),
      hasMusicXml: Boolean(
        job.musicXmlBundle || job.pages.some((page) => effectivePageMusicXml(page, enginePlan))
      ),
      hasPdf: this.materializedArtifactIsCurrent(
        job.previewPdf,
        SCANNER_ARTIFACT_BUILDERS.previewPdf,
        job.pages,
        legacyJobInvalidated
      ),
      hasThumbnail: this.materializedArtifactIsCurrent(
        job.previewThumbnail,
        SCANNER_ARTIFACT_BUILDERS.previewThumbnail,
        job.pages,
        legacyJobInvalidated
      ),
      hasZip: Boolean(
        job.resultsZip || job.pages.some((page) => effectivePageMusicXml(page, enginePlan))
      ),
      mergeStatus: job.mergeStatus || 'not-requested',
      mergeReason: job.mergeReason,
      hasCombinedMusicXml: this.materializedArtifactIsCurrent(
        job.combinedMusicXml,
        SCANNER_ARTIFACT_BUILDERS.combinedMusicXml,
        job.pages,
        legacyJobInvalidated
      ),
      hasCombinedPdf: this.materializedArtifactIsCurrent(
        job.combinedPdf,
        SCANNER_ARTIFACT_BUILDERS.combinedPdf,
        job.pages,
        legacyJobInvalidated
      ),
      providerRevision: job.providerRevision,
      modelRevision: job.modelRevision,
      timings: job.timings || {},
      errorCode: job.errorCode,
      errorMessage: job.errorMessage,
      canRetry: this.retryEligibility(job).allowed,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      resultExpiresAt: job.resultExpiresAt
    };
  }

  private presentEngineRun(run: ScannerEngineRun): any {
    return {
      status: run.status,
      attempts: run.attempts,
      providerAttempts: run.providerAttempts,
      providerRequestId: run.providerRequestId,
      durationMs: run.durationMs,
      inferenceMs: run.inferenceMs,
      recognitionRaster: run.recognitionRaster,
      generation: run.generation,
      completeness: run.completeness,
      errorCode: run.errorCode,
      errorMessage: run.errorMessage,
      providerRevision: run.providerRevision,
      modelRevision: run.modelRevision,
      hasMusicXml: Boolean(run.artifacts.musicXml),
      hasPdf: Boolean(run.artifacts.pdf),
      hasKern: Boolean(run.artifacts.kern),
      artifactKinds: Object.entries(run.artifacts || {}).flatMap(([kind, locator]) =>
        locator ? [kind === 'musicXml' ? 'musicxml' : kind] : []
      )
    };
  }

  /** Stop new work only when no enabled recognition engine has capacity. */
  private providerCapacityExhausted(): boolean {
    if (this.registeredEngines) return this.registeredEngines.newJobCapacityExhausted();
    if (!this.bool('SCANNER_PROVIDER_BUDGET_EXHAUSTED', false)) return false;
    return (
      !this.bool('SCANNER_TRANSCODA_ENABLED', false) ||
      this.bool('SCANNER_TRANSCODA_PROVIDER_BUDGET_EXHAUSTED', false)
    );
  }

  private async detectInputType(path: string): Promise<string> {
    const handle = await fs.open(path, 'r');
    try {
      const header = Buffer.alloc(8);
      await handle.read(header, 0, header.length, 0);
      if (header.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
      if (header.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
      if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg';
    } finally {
      await handle.close();
    }
    throw new BadRequestException('Only PDF, PNG, and JPEG inputs are supported');
  }

  private async readPdfPageCount(path: string): Promise<number> {
    let stdout: string;
    try {
      // A user-password PDF makes pdfinfo itself fail, which lands here.
      ({ stdout } = await execFileAsync('pdfinfo', [path], { timeout: 15_000 }));
    } catch {
      throw new BadRequestException('The PDF is invalid or its page count could not be read');
    }
    return this.parsePdfInfo(stdout);
  }

  /** Split out from the `pdfinfo` call so the acceptance rules stay testable. */
  parsePdfInfo(stdout: string): number {
    // Design section 5.1 rejects encrypted PDFs in the beta. An owner-password
    // PDF still reports a page count, so it has to be refused explicitly rather
    // than left to fail later during rasterization.
    if (/^Encrypted:\s+yes/im.test(stdout)) {
      throw new BadRequestException(
        'Encrypted or password-protected PDFs are not supported; remove the protection and try again'
      );
    }
    const match = stdout.match(/^Pages:\s+(\d+)\s*$/im);
    const count = Number(match?.[1]);
    if (!Number.isInteger(count) || count < 1) {
      throw new BadRequestException('The PDF is invalid or its page count could not be read');
    }
    return count;
  }

  private async readImageDimensions(
    path: string,
    maxPixels: number
  ): Promise<{ width: number; height: number }> {
    try {
      const metadata = await sharp(path, {
        failOn: 'error',
        limitInputPixels: maxPixels
      }).metadata();
      const width = Number(metadata.width || 0);
      const height = Number(metadata.height || 0);
      if (width > 0 && height > 0) return { width, height };
    } catch {
      // Return the same safe client error for truncated images and decode-bomb limits.
    }
    throw new BadRequestException('The image is invalid or its dimensions could not be read');
  }

  private hashFile(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = createReadStream(path);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  private async deleteArtifacts(job: ScannerJobDocument): Promise<void> {
    const locators = uniqueScannerStorageLocators([
      job.input,
      ...(job.inputs || []).map((item) => item.storage),
      job.musicXmlBundle,
      job.combinedMusicXml,
      job.combinedPdf,
      job.resultsZip,
      job.previewPdf,
      job.previewThumbnail,
      ...job.pages.flatMap((page) => [
        page.sourceImage,
        page.thumbnail,
        page.recognitionRaster?.storage,
        ...(page.recognitionRasterHistory || []).map((raster) => raster.storage),
        page.musicXml,
        page.reviewedMusicXml,
        page.mergedMusicXml,
        page.pdf,
        ...scannerEngineArtifactLocators(page)
      ])
    ]);
    await Promise.all(
      locators.map((item) => this.storage.deleteObject(item.bucket, item.objectKey))
    );
  }

  private currentMusicXmlPages(job: ScannerJobDocument): Array<{
    page: ScannerPageResult;
    musicXml: ScannerStorageLocator;
  }> {
    return [...job.pages]
      .sort(
        (left, right) => (left.ordinal || left.pageNumber) - (right.ordinal || right.pageNumber)
      )
      .flatMap((page) => {
        const musicXml = effectivePageMusicXml(page, this.enginePlanForJob(job));
        return page.status === 'succeeded' && musicXml ? [{ page, musicXml }] : [];
      });
  }

  private artifactInputs(
    pages: ScannerPageResult[],
    enginePlan?: { primaryEngineId: string; fallbackEngineIds: string[] }
  ): ScannerArtifactInput[] | undefined {
    const inputs: ScannerArtifactInput[] = [];
    for (const page of [...pages].sort(
      (left, right) => (left.ordinal || left.pageNumber) - (right.ordinal || right.pageNumber)
    )) {
      const musicXml = effectivePageMusicXml(page, enginePlan);
      if (!musicXml) continue;
      if (!musicXml.checksumSha256) return undefined;
      inputs.push({
        ordinal: page.ordinal || page.pageNumber,
        checksumSha256: musicXml.checksumSha256
      });
    }
    return inputs;
  }

  /**
   * Signed artifacts are strict. Unsigned pre-migration artifacts remain usable
   * only while no review/merge has invalidated their known raw-page inputs.
   */
  private materializedArtifactIsCurrent(
    locator: ScannerStorageLocator | undefined,
    builderVersion: string,
    pages: ScannerPageResult[],
    legacyInvalidated: boolean
  ): boolean {
    if (!locator) return false;
    const inputs = this.artifactInputs(pages);
    if (locator.inputSignature) {
      return Boolean(inputs && scannerArtifactInputMatches(locator, builderVersion, inputs));
    }
    return !legacyInvalidated;
  }

  private async currentMusicXmlBundle(
    job: ScannerJobDocument,
    pages = this.currentMusicXmlPages(job)
  ): Promise<Buffer> {
    if (pages.length === 0) throw new NotFoundException('Artifact is not available');
    const zip = new AdmZip();
    for (const { page, musicXml } of pages) {
      zip.addFile(
        `page-${String(page.ordinal || page.pageNumber).padStart(3, '0')}.musicxml`,
        await this.storage.getObjectBuffer(musicXml.bucket, musicXml.objectKey)
      );
    }
    return zip.toBuffer();
  }

  private async currentResultsZip(job: ScannerJobDocument): Promise<Buffer> {
    const zip = new AdmZip();
    const pages = [...job.pages].sort(
      (left, right) => (left.ordinal || left.pageNumber) - (right.ordinal || right.pageNumber)
    );
    const enginePlan = this.enginePlanForJob(job);
    const inputs = this.artifactInputs(pages, enginePlan);
    for (const page of pages) {
      const pageSegment = String(page.ordinal || page.pageNumber).padStart(3, '0');
      const musicXml = effectivePageMusicXml(page, enginePlan);
      if (musicXml) {
        zip.addFile(
          `page-${pageSegment}.musicxml`,
          await this.storage.getObjectBuffer(musicXml.bucket, musicXml.objectKey)
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
    }

    const manifest = {
      version: 1,
      jobId: job.jobId,
      status: job.status,
      mergeStatus: 'stale',
      mergeReason:
        job.mergeReason || 'Stored result artifacts do not match the current page inputs',
      engine: 'homr',
      enginePlan: this.enginePlanForJob(job),
      serviceRevision: job.providerRevision,
      modelRevision: job.modelRevision,
      engineProvenance: job.engineProvenance,
      ...(inputs
        ? {
            inputSignature: scannerArtifactInputSignature({
              builderVersion: SCANNER_ARTIFACT_BUILDERS.resultsZip,
              pages: inputs
            })
          }
        : {}),
      createdAt: new Date().toISOString(),
      pages: pages.map((page) => {
        const musicXml = effectivePageMusicXml(page, this.enginePlanForJob(job));
        return {
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
          musicXmlSha256: musicXml?.checksumSha256,
          pdfSha256: this.materializedArtifactIsCurrent(
            page.pdf,
            SCANNER_ARTIFACT_BUILDERS.pagePdf,
            [page],
            pageMusicXmlSuperseded(page)
          )
            ? page.pdf?.checksumSha256
            : undefined
        };
      })
    };
    zip.addFile('scanner-manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
    zip.addFile(
      'README.txt',
      Buffer.from(
        'OurTextScores Scanner results\n\nEach page is transcribed independently. Review all MusicXML before use.\n\nA review changed at least one page after the original combined score and PDFs were built. Those stale derivatives are intentionally omitted; the MusicXML page files in this archive are current.\n'
      )
    );
    return zip.toBuffer();
  }

  private safeFilename(value: string, fallbackExtension: string): string {
    const base = String(value || 'score')
      .replace(/[^a-zA-Z0-9._ -]+/g, '_')
      .slice(0, 180);
    return extname(base) ? base : `${base}${fallbackExtension}`;
  }

  private sortUploadedFiles(files: Express.Multer.File[]): Express.Multer.File[] {
    return files
      .map((file, index) => ({ file, index }))
      .sort(
        (left, right) =>
          left.file.originalname.localeCompare(right.file.originalname, 'en', {
            numeric: true,
            sensitivity: 'base'
          }) ||
          left.file.originalname.localeCompare(right.file.originalname, 'en') ||
          left.index - right.index
      )
      .map(({ file }) => file);
  }

  private retryEligibility(job: ScannerJobDocument): { allowed: boolean; reason: string } {
    if (
      !job.sourceExpiresAt ||
      job.sourceDeletedAt ||
      job.sourceExpiresAt.getTime() <= Date.now()
    ) {
      return { allowed: false, reason: 'The retained source file has expired' };
    }
    if (
      !['cancelled', 'failed', 'partial'].includes(job.status) &&
      !(
        job.status === 'succeeded' &&
        job.pages.some((page) => page.status === 'succeeded' && !page.pdf)
      )
    ) {
      return { allowed: false, reason: 'Only cancelled, failed, or partial jobs can be retried' };
    }
    return this.retryablePageNumbers(job).length > 0
      ? { allowed: true, reason: '' }
      : {
          allowed: false,
          reason: 'No pages have a safe retry remaining'
        };
  }

  private pageRetryEligibility(
    job: ScannerJobDocument,
    pageNumber: number,
    page?: ScannerPageResult
  ): { allowed: boolean; reason: string } {
    if (
      !job.sourceExpiresAt ||
      job.sourceDeletedAt ||
      job.sourceExpiresAt.getTime() <= Date.now()
    ) {
      return { allowed: false, reason: 'The retained source file has expired' };
    }
    if (!['cancelled', 'failed', 'partial', 'succeeded'].includes(job.status)) {
      return { allowed: false, reason: 'The job is not in a retryable state' };
    }
    if (pageNumber < 1 || pageNumber > job.pageCount) {
      return { allowed: false, reason: 'Scanner page not found' };
    }
    const manualRetries = page?.manualRetries || 0;
    const maxRetries = this.number('SCANNER_MAX_MANUAL_RETRIES', 1);
    if (manualRetries >= maxRetries) {
      return { allowed: false, reason: 'The page retry limit has been reached' };
    }
    if (!page || ['pending', 'running', 'cancelled'].includes(page.status)) {
      return job.status === 'cancelled'
        ? { allowed: true, reason: '' }
        : { allowed: false, reason: 'The page has not failed' };
    }
    if (page.status === 'succeeded' && !page.pdf) {
      const enginePlan = this.enginePlanForJob(job);
      const primaryEngineId = enginePlan.primaryEngineId;
      const primary =
        primaryEngineId === 'homr' ? scannerHomrRun(page) : page.engines?.[primaryEngineId];
      if (!primary || primary.status === 'succeeded') return { allowed: true, reason: '' };
      if (primary.status === 'failed' && isRetryableScannerErrorCode(primary.errorCode)) {
        return { allowed: true, reason: '' };
      }
      return { allowed: false, reason: 'This page failure cannot be retried safely' };
    }
    if (page.status === 'failed' && isRetryableScannerErrorCode(page.errorCode)) {
      return { allowed: true, reason: '' };
    }
    return { allowed: false, reason: 'This page failure cannot be retried safely' };
  }

  private retryablePageNumbers(job: ScannerJobDocument): number[] {
    return Array.from({ length: job.pageCount }, (_value, index) => index + 1).filter(
      (pageNumber) =>
        this.pageRetryEligibility(
          job,
          pageNumber,
          job.pages.find((page) => page.pageNumber === pageNumber)
        ).allowed
    );
  }

  private async queueRetry(existing: ScannerJobDocument, pageNumbers: number[]): Promise<any> {
    const selected = [...new Set(pageNumbers)].sort((left, right) => left - right);
    if (selected.length === 0) throw new ConflictException('No pages can be retried safely');
    const activeLimit = this.number('SCANNER_MAX_ACTIVE_JOBS_PER_USER', 2);
    const active = await this.jobs
      .countDocuments({ userId: existing.userId, status: { $in: ACTIVE_STATUSES } })
      .exec();
    if (active >= activeLimit) {
      throw new ConflictException(`At most ${activeLimit} scanner jobs may be active`);
    }

    const selectedSet = new Set(selected);
    const pages = existing.pages.map((page) =>
      selectedSet.has(page.pageNumber)
        ? { ...page, manualRetries: (page.manualRetries || 0) + 1 }
        : page
    );
    const job = await this.jobs
      .findOneAndUpdate(
        {
          _id: existing._id,
          userId: existing.userId,
          jobId: existing.jobId,
          status: existing.status,
          generation: existing.generation
        },
        {
          $set: {
            status: 'queued',
            generation: existing.generation + 1,
            retryPageNumbers: selected,
            pages
          },
          $inc: { statusVersion: 1 },
          $unset: {
            completedAt: 1,
            errorCode: 1,
            errorMessage: 1,
            leaseExpiresAt: 1,
            leaseOwner: 1,
            terminalNotifiedAt: 1
          }
        },
        { new: true }
      )
      .exec();
    if (!job) throw new ConflictException('Scanner job changed; refresh and try again');
    return this.present(job);
  }

  private userHash(userId: string): string {
    return scannerUserHash(userId, this.config.get<string>('SCANNER_OBJECT_KEY_SALT', ''));
  }

  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private newJobEnginePlan() {
    return (
      this.registeredEngines?.newJobPlan() ||
      scannerDefaultEnginePlan(this.bool('SCANNER_TRANSCODA_ENABLED', false))
    );
  }

  private enginePlanForJob(job: ScannerJobDocument) {
    return (
      this.registeredEngines?.planForJob(job) ||
      scannerEnginePlanForJob(job, this.bool('SCANNER_TRANSCODA_ENABLED', false))
    );
  }

  /** Resolve spot review through the persisted capability plan, never an engine-name branch. */
  private reviewEngineForPage(
    job: ScannerJobDocument,
    page: ScannerPageResult,
    requestedEngineId?: string
  ): { engineId: ScannerEngineId; run: ScannerEngineRun; adapter?: ScannerPageProvider } {
    const plan = this.enginePlanForJob(job);
    if (requestedEngineId && !isScannerEngineId(requestedEngineId)) {
      throw new BadRequestException('Invalid scanner engine');
    }
    if (requestedEngineId && !plan.engineIds.includes(requestedEngineId)) {
      throw new BadRequestException('Scanner engine is not part of this job');
    }

    const engineIds = requestedEngineId ? [requestedEngineId] : plan.engineIds;
    for (const engineId of engineIds) {
      if (!plan.capabilitySnapshots[engineId]?.supportsSpotReview) continue;
      const run =
        engineId === 'homr'
          ? scannerHomrRun(page, {
              providerRevision: job.providerRevision,
              modelRevision: job.modelRevision,
              provenance: job.engineProvenance
            })
          : page.engines?.[engineId];
      if (run?.status !== 'succeeded' || !run.review) continue;
      return {
        engineId,
        run,
        adapter:
          this.registeredEngines?.readable(engineId)?.adapter ||
          (engineId === 'homr' ? this.provider : undefined)
      };
    }

    if (requestedEngineId && !plan.capabilitySnapshots[requestedEngineId]?.supportsSpotReview) {
      throw new ConflictException('This scanner engine does not support spot review');
    }
    throw new ConflictException('No reviewable scanner engine result is available for this page');
  }

  private number(key: string, fallback: number): number {
    const parsed = Number(this.config.get<string>(key, String(fallback)));
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  }

  private bool(key: string, fallback: boolean): boolean {
    return (
      this.config.get<string>(key, String(fallback)).toLowerCase() === 'true' ||
      this.config.get<string>(key, '') === '1'
    );
  }
}
