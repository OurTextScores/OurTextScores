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
  ScannerStorageLocator
} from './schemas/scanner-job.schema';
import { SCANNER_UPLOAD_DIRECTORY } from './scanner.constants';
import { isRetryableScannerErrorCode } from './scanner.errors';

const execFileAsync = promisify(execFile);
const ACTIVE_STATUSES = ['queued', 'preparing', 'running', 'rendering'];

@Injectable()
export class ScannerService implements OnModuleInit {
  private readonly logger = new Logger(ScannerService.name);

  constructor(
    @InjectModel(ScannerJob.name)
    private readonly jobs: Model<ScannerJobDocument>,
    private readonly storage: StorageService,
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
    file: Express.Multer.File;
    detectTitle?: boolean;
  }): Promise<any> {
    this.assertAvailable(input.userId);
    if (this.bool('SCANNER_PROVIDER_BUDGET_EXHAUSTED', false)) {
      throw new ServiceUnavailableException('Scanner monthly capacity has been reached');
    }
    const maxBytes = this.number('SCANNER_MAX_UPLOAD_BYTES', 25 * 1024 * 1024);
    if (!input.file || !input.file.path) {
      throw new BadRequestException('A score image or PDF is required');
    }
    if (input.file.size > maxBytes) {
      throw new PayloadTooLargeException(`Upload exceeds the ${maxBytes} byte limit`);
    }

    const detected = await this.detectInputType(input.file.path);
    if (detected !== 'application/pdf') {
      const maxDimension = this.number('SCANNER_MAX_IMAGE_DIMENSION', 12_000);
      const maxPixels = this.number('SCANNER_MAX_IMAGE_PIXELS', 80_000_000);
      const dimensions = await this.readImageDimensions(input.file.path, maxPixels);
      const aspectRatio =
        Math.max(dimensions.width, dimensions.height) /
        Math.min(dimensions.width, dimensions.height);
      const maxAspectRatio = this.number('SCANNER_MAX_IMAGE_ASPECT_RATIO', 20);
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
    const pageCount =
      detected === 'application/pdf' ? await this.readPdfPageCount(input.file.path) : 1;
    const maxPages = this.number('SCANNER_MAX_PAGES', 20);
    if (pageCount > maxPages) {
      throw new PayloadTooLargeException(`PDF has ${pageCount} pages; the limit is ${maxPages}`);
    }

    await this.assertQuota(input.userId, pageCount);

    const jobId = randomUUID();
    const extension =
      detected === 'application/pdf' ? '.pdf' : detected === 'image/png' ? '.png' : '.jpg';
    const objectKey = `scanner/${input.userId}/${jobId}/source${extension}`;
    const checksumSha256 = await this.hashFile(input.file.path);
    const stored = await this.storage.putRawObject(
      objectKey,
      createReadStream(input.file.path),
      input.file.size,
      detected
    );
    const locator: ScannerStorageLocator = {
      bucket: stored.bucket,
      objectKey: stored.objectKey,
      sizeBytes: input.file.size,
      contentType: detected,
      checksumSha256
    };
    const now = Date.now();

    try {
      const job = await this.jobs.create({
        jobId,
        userId: input.userId,
        status: 'queued',
        originalFilename: this.safeFilename(input.file.originalname, extension),
        inputContentType: detected,
        pageCount,
        input: locator,
        options: { detectTitle: Boolean(input.detectTitle) },
        generation: 1,
        pages: Array.from({ length: pageCount }, (_value, index) => ({
          pageNumber: index + 1,
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
      return this.present(job);
    } catch (error) {
      await this.storage.deleteObject(locator.bucket, locator.objectKey);
      throw error;
    }
  }

  async listJobs(userId: string): Promise<any[]> {
    this.assertAvailable(userId);
    const jobs = await this.jobs.find({ userId }).sort({ createdAt: -1 }).limit(50).exec();
    return jobs.map((job) => this.present(job));
  }

  async getJob(userId: string, jobId: string): Promise<any> {
    this.assertAvailable(userId);
    return this.present(await this.ownedJob(userId, jobId));
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
          }
        },
        { new: true }
      )
      .exec();
    if (job) return this.present(job);
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
        : job.previewPdf;
      filename = pageRequested ? `scan-page-${pageNumber}.pdf` : 'scan-preview.pdf';
    } else if (kind === 'thumbnail') {
      locator = pageRequested
        ? job.pages.find((page) => page.pageNumber === pageNumber)?.thumbnail
        : job.previewThumbnail;
      filename = pageRequested ? `scan-page-${pageNumber}.png` : 'scan-preview.png';
    } else if (pageRequested) {
      locator = job.pages.find((page) => page.pageNumber === pageNumber)?.musicXml;
      filename = `scan-page-${pageNumber}.musicxml`;
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
      originalFilename: job.originalFilename,
      pageCount: job.pageCount,
      options: job.options,
      pages: job.pages.map((page) => ({
        pageNumber: page.pageNumber,
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
    try {
      const { stdout } = await execFileAsync('pdfinfo', [path], { timeout: 15_000 });
      const match = stdout.match(/^Pages:\s+(\d+)\s*$/im);
      const count = Number(match?.[1]);
      if (!Number.isInteger(count) || count < 1) throw new Error('page count missing');
      return count;
    } catch {
      throw new BadRequestException('The PDF is invalid or its page count could not be read');
    }
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
      job.musicXmlBundle,
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
