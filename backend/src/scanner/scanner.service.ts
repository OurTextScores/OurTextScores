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
import { StorageService } from '../storage/storage.service';
import {
  ScannerJob,
  ScannerJobDocument,
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
      const dimensions = await this.readImageDimensions(input.file.path, detected);
      const maxDimension = this.number('SCANNER_MAX_IMAGE_DIMENSION', 12_000);
      const maxPixels = this.number('SCANNER_MAX_IMAGE_PIXELS', 80_000_000);
      if (
        dimensions.width > maxDimension ||
        dimensions.height > maxDimension ||
        dimensions.width * dimensions.height > maxPixels
      ) {
        throw new PayloadTooLargeException(
          `Image dimensions exceed the ${maxDimension}px/${maxPixels}-pixel limit`
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
        pages: [],
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

    const activeLimit = this.number('SCANNER_MAX_ACTIVE_JOBS_PER_USER', 2);
    const active = await this.jobs
      .countDocuments({ userId, status: { $in: ACTIVE_STATUSES } })
      .exec();
    if (active >= activeLimit) {
      throw new ConflictException(`At most ${activeLimit} scanner jobs may be active`);
    }

    const job = await this.jobs
      .findOneAndUpdate(
        {
          _id: existing._id,
          userId,
          jobId,
          status: existing.status,
          generation: existing.generation
        },
        {
          $set: { status: 'queued', generation: existing.generation + 1 },
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
    kind: 'musicxml' | 'pdf' | 'thumbnail',
    pageNumber?: number
  ): Promise<{ stream: Readable; contentType: string; filename: string }> {
    this.assertAvailable(userId);
    const job = await this.ownedJob(userId, jobId);
    let locator: ScannerStorageLocator | undefined;
    let filename: string;
    if (kind === 'pdf') {
      locator = job.previewPdf;
      filename = 'scan-preview.pdf';
    } else if (kind === 'thumbnail') {
      locator = job.previewThumbnail;
      filename = 'scan-preview.png';
    } else if (pageNumber) {
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
        status: page.status,
        attempts: page.attempts,
        errorCode: page.errorCode,
        errorMessage: page.errorMessage,
        hasMusicXml: Boolean(page.musicXml),
        hasPdf: Boolean(page.pdf)
      })),
      hasMusicXml: Boolean(job.musicXmlBundle || job.pages.some((page) => page.musicXml)),
      hasPdf: Boolean(job.previewPdf),
      hasThumbnail: Boolean(job.previewThumbnail),
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
    contentType: string
  ): Promise<{ width: number; height: number }> {
    const handle = await fs.open(path, 'r');
    try {
      if (contentType === 'image/png') {
        const header = Buffer.alloc(24);
        await handle.read(header, 0, header.length, 0);
        const width = header.readUInt32BE(16);
        const height = header.readUInt32BE(20);
        if (width > 0 && height > 0) return { width, height };
      } else {
        let offset = 2;
        while (offset < Math.min((await handle.stat()).size, 1024 * 1024)) {
          const marker = Buffer.alloc(4);
          const read = await handle.read(marker, 0, marker.length, offset);
          if (read.bytesRead < 4 || marker[0] !== 0xff) break;
          const markerType = marker[1];
          const segmentLength = marker.readUInt16BE(2);
          if (
            [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
              markerType
            )
          ) {
            const dimensions = Buffer.alloc(5);
            const value = await handle.read(dimensions, 0, dimensions.length, offset + 4);
            if (value.bytesRead === 5) {
              const height = dimensions.readUInt16BE(1);
              const width = dimensions.readUInt16BE(3);
              if (width > 0 && height > 0) return { width, height };
            }
            break;
          }
          if (segmentLength < 2) break;
          offset += 2 + segmentLength;
        }
      }
    } finally {
      await handle.close();
    }
    throw new BadRequestException('The image dimensions could not be read');
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
      job.previewPdf,
      job.previewThumbnail,
      ...job.pages.flatMap((page) => [page.musicXml, page.pdf])
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
    const maxRetries = this.number('SCANNER_MAX_MANUAL_RETRIES', 1);
    if (job.generation > maxRetries) {
      return { allowed: false, reason: 'The manual retry limit has been reached' };
    }
    if (
      !job.sourceExpiresAt ||
      job.sourceDeletedAt ||
      job.sourceExpiresAt.getTime() <= Date.now()
    ) {
      return { allowed: false, reason: 'The retained source file has expired' };
    }
    if (job.status === 'cancelled') return { allowed: true, reason: '' };
    if (job.errorCode === 'preview_render_failed' && job.pages.some((page) => page.musicXml)) {
      return { allowed: true, reason: '' };
    }
    if (!['failed', 'partial'].includes(job.status)) {
      return { allowed: false, reason: 'Only cancelled, failed, or partial jobs can be retried' };
    }
    const retryableFailure = job.pages.some(
      (page) =>
        page.status === 'failed' &&
        isRetryableScannerErrorCode(page.errorCode)
    );
    return retryableFailure
      ? { allowed: true, reason: '' }
      : { allowed: false, reason: 'This failure is deterministic and cannot be retried safely' };
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
