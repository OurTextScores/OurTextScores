import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
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
import sharp = require('sharp');
import { StorageService } from '../storage/storage.service';
import {
  ScannerJob,
  ScannerJobDocument,
  ScannerPageResult,
  ScannerSourceInput,
  ScannerStorageLocator
} from './schemas/scanner-job.schema';
import { SCANNER_UPLOAD_DIRECTORY, scannerUserHash } from './scanner.constants';
import { ScannerTelemetryService } from './scanner-telemetry.service';
import { isRetryableScannerErrorCode } from './scanner.errors';

const execFileAsync = promisify(execFile);
const ACTIVE_STATUSES = ['queued', 'preparing', 'ready', 'running', 'rendering'];

@Injectable()
export class ScannerService implements OnModuleInit {
  private readonly logger = new Logger(ScannerService.name);

  constructor(
    @InjectModel(ScannerJob.name)
    private readonly jobs: Model<ScannerJobDocument>,
    private readonly storage: StorageService,
    private readonly telemetry: ScannerTelemetryService,
    private readonly config: ConfigService
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
    if (this.bool('SCANNER_PROVIDER_BUDGET_EXHAUSTED', false)) {
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
        pages: Array.from({ length: pageCount }, (_value, index) => ({
          pageNumber: index + 1,
          ordinal: index + 1,
          rotationDegrees: 0,
          included: true,
          status: 'pending',
          attempts: 0,
          manualRetries: 0,
          idempotencyKey: ''
        })),
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
      return {
        ...page,
        ordinal: requested.ordinal,
        rotationDegrees: requested.rotationDegrees as 0 | 90 | 180 | 270,
        included: Boolean(requested.included),
        status: requested.included ? 'pending' : 'skipped'
      };
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
    if (this.bool('SCANNER_PROVIDER_BUDGET_EXHAUSTED', false)) {
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
    if (this.bool('SCANNER_PROVIDER_BUDGET_EXHAUSTED', false)) {
      throw new ServiceUnavailableException('Scanner monthly capacity has been reached');
    }
    const existing = await this.ownedJob(userId, jobId);
    const eligibility = this.retryEligibility(existing);
    if (!eligibility.allowed) throw new ConflictException(eligibility.reason);
    return this.queueRetry(existing, this.retryablePageNumbers(existing));
  }

  async retryPage(userId: string, jobId: string, pageNumber: number): Promise<any> {
    this.assertAvailable(userId);
    if (this.bool('SCANNER_PROVIDER_BUDGET_EXHAUSTED', false)) {
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
    kind: 'musicxml' | 'pdf' | 'thumbnail' | 'zip',
    pageNumber?: number
  ): Promise<{ stream: Readable; contentType: string; filename: string }> {
    this.assertAvailable(userId);
    const job = await this.ownedJob(userId, jobId);
    if (pageNumber !== undefined && (pageNumber < 1 || pageNumber > job.pageCount)) {
      throw new NotFoundException('Scanner page not found');
    }
    const pageRequested = pageNumber !== undefined;
    let locator: ScannerStorageLocator | undefined;
    let filename: string;
    if (kind === 'zip') {
      locator = job.resultsZip;
      filename = 'scan-results.zip';
    } else if (kind === 'pdf') {
      locator = pageRequested
        ? job.pages.find((page) => page.pageNumber === pageNumber)?.pdf
        : (job.combinedPdf ?? job.previewPdf);
      filename = pageRequested ? `scan-page-${pageNumber}.pdf` : 'scan-preview.pdf';
    } else if (kind === 'thumbnail') {
      locator = pageRequested
        ? job.pages.find((page) => page.pageNumber === pageNumber)?.thumbnail
        : job.previewThumbnail;
      filename = pageRequested ? `scan-page-${pageNumber}.png` : 'scan-preview.png';
    } else if (pageRequested) {
      locator = job.pages.find((page) => page.pageNumber === pageNumber)?.musicXml;
      filename = `scan-page-${pageNumber}.musicxml`;
    } else if (job.combinedMusicXml) {
      // A validated assembly is the whole score, so it wins over the per-page
      // bundle for the job-level MusicXML artifact.
      locator = job.combinedMusicXml;
      filename = 'scan-combined.musicxml';
    } else {
      locator =
        job.musicXmlBundle ?? job.pages.find((page) => page.status === 'succeeded')?.musicXml;
      filename = job.pageCount === 1 ? 'scan.musicxml' : 'scan-musicxml-pages.zip';
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

    const [byStatus, oldestQueued, recent] = await Promise.all([
      this.jobs
        .aggregate([
          { $match: { createdAt: { $gte: since } } },
          { $group: { _id: '$status', jobs: { $sum: 1 }, pages: { $sum: '$pageCount' } } }
        ])
        .exec(),
      this.jobs.find({ status: 'queued' }).sort({ queuedAt: 1 }).limit(1).exec(),
      this.jobs
        .find({ createdAt: { $gte: since } })
        .select({ pages: 1, timings: 1 })
        .lean()
        .exec()
    ]);

    const pageDurations: number[] = [];
    const failuresByCode: Record<string, number> = {};
    let pagesSucceeded = 0;
    let pagesFailed = 0;
    let pagesRendered = 0;
    let providerCalls = 0;
    let providerMsTotal = 0;

    for (const job of recent as any[]) {
      providerMsTotal += Number(job.timings?.providerMs || 0);
      for (const page of job.pages || []) {
        if (page.status === 'succeeded') {
          pagesSucceeded += 1;
          if (page.pdf) pagesRendered += 1;
          if (Number.isFinite(page.durationMs)) pageDurations.push(page.durationMs);
        } else if (page.status === 'failed') {
          pagesFailed += 1;
          const code = String(page.errorCode || 'unknown');
          failuresByCode[code] = (failuresByCode[code] || 0) + 1;
        }
        providerCalls += Number(page.providerAttempts || page.attempts || 0);
      }
    }

    const queueDepth = byStatus
      .filter((row: any) => ['queued', 'running', 'rendering'].includes(row._id))
      .reduce((sum: number, row: any) => sum + row.jobs, 0);

    return {
      windowHours: hours,
      generatedAt: new Date().toISOString(),
      jobs: Object.fromEntries(byStatus.map((row: any) => [row._id, row.jobs])),
      pagesByStatus: { succeeded: pagesSucceeded, failed: pagesFailed },
      queue: {
        depth: queueDepth,
        oldestQueuedAgeMs: oldestQueued[0]?.queuedAt
          ? now - oldestQueued[0].queuedAt.getTime()
          : null
      },
      pageLatencyMs: {
        samples: pageDurations.length,
        p50: this.percentile(pageDurations, 0.5),
        p95: this.percentile(pageDurations, 0.95),
        max: pageDurations.length ? Math.max(...pageDurations) : null
      },
      failureRate:
        pagesSucceeded + pagesFailed > 0
          ? Number((pagesFailed / (pagesSucceeded + pagesFailed)).toFixed(4))
          : 0,
      failuresByCode,
      renderSuccessRate:
        pagesSucceeded > 0 ? Number((pagesRendered / pagesSucceeded).toFixed(4)) : null,
      provider: {
        calls: providerCalls,
        // Approximate: wall-clock time OTS spent inside provider calls, which
        // is an upper bound on billable GPU seconds, not a billing figure.
        approximateSeconds: Math.round(providerMsTotal / 1000)
      }
    };
  }

  private percentile(values: number[], fraction: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
    return sorted[index];
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

  private async ownedJob(userId: string, jobId: string): Promise<ScannerJobDocument> {
    const job = await this.jobs.findOne({ userId, jobId }).exec();
    if (!job) throw new NotFoundException('Scanner job not found');
    return job;
  }

  private present(job: ScannerJobDocument): any {
    return {
      jobId: job.jobId,
      status: job.status,
      statusVersion: job.statusVersion || 1,
      originalFilename: job.originalFilename,
      pageCount: job.pageCount,
      includedPageCount: job.pages.filter((page) => page.included !== false).length,
      options: job.options,
      pages: [...job.pages]
        .sort(
          (left, right) => (left.ordinal || left.pageNumber) - (right.ordinal || right.pageNumber)
        )
        .map((page) => ({
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
          hasMusicXml: Boolean(page.musicXml),
          hasPdf: Boolean(page.pdf),
          canRetry: this.pageRetryEligibility(job, page.pageNumber, page).allowed
        })),
      hasMusicXml: Boolean(job.musicXmlBundle || job.pages.some((page) => page.musicXml)),
      hasPdf: Boolean(job.previewPdf),
      hasThumbnail: Boolean(job.previewThumbnail),
      hasZip: Boolean(job.resultsZip),
      mergeStatus: job.mergeStatus || 'not-requested',
      mergeReason: job.mergeReason,
      hasCombinedMusicXml: Boolean(job.combinedMusicXml),
      hasCombinedPdf: Boolean(job.combinedPdf),
      providerRevision: job.providerRevision,
      modelRevision: job.modelRevision,
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
    const locators = [
      job.input,
      ...(job.inputs || []).map((item) => item.storage),
      job.musicXmlBundle,
      job.combinedMusicXml,
      job.combinedPdf,
      job.resultsZip,
      job.previewPdf,
      job.previewThumbnail,
      ...job.pages.flatMap((page) => [page.sourceImage, page.thumbnail, page.musicXml, page.pdf])
    ].filter(Boolean) as ScannerStorageLocator[];
    await Promise.all(
      locators.map((item) => this.storage.deleteObject(item.bucket, item.objectKey))
    );
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
    if (page.status === 'succeeded' && !page.pdf) return { allowed: true, reason: '' };
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
