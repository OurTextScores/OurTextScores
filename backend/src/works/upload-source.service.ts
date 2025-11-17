import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { WorksService } from './works.service';
import { Source, SourceDocument } from './schemas/source.schema';
import { StorageService } from '../storage/storage.service';
import { StorageLocator } from './schemas/storage-locator.schema';
import { ValidationState } from './schemas/validation.schema';
import { Provenance } from './schemas/provenance.schema';
import {
  DerivativePipelineService,
  DerivativeManifest,
  DerivativePipelineResult
} from './derivative-pipeline.service';
import { SourceRevision, SourceRevisionDocument } from './schemas/source-revision.schema';
import { FossilService, FossilCommitFile } from '../fossil/fossil.service';
import { ProgressService } from '../progress/progress.service';
import { BranchesService } from '../branches/branches.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { RequestUser } from '../auth/types/auth-user';

export interface UploadSourceRequest {
  label?: string;
  sourceType?: 'score' | 'parts' | 'audio' | 'metadata' | 'other';
  description?: string;
  license?: string;
  licenseUrl?: string;
  licenseAttribution?: string;
  isPrimary?: boolean;
  formatHint?: string;
  commitMessage?: string;
  createBranch?: boolean;
  branchName?: string;
}

export interface UploadSourceResult {
  workId: string;
  sourceId: string;
  revisionId: string;
  status: 'accepted' | 'pending';
  message: string;
  receivedBytes: number;
  originalFilename: string;
  mimeType: string;
  notes: string[];
  manifest?: StorageLocator;
  manifestData?: DerivativeManifest;
}

@Injectable()
export class UploadSourceService {
  constructor(
    private readonly worksService: WorksService,
    private readonly storageService: StorageService,
    private readonly derivativePipeline: DerivativePipelineService,
    private readonly fossilService: FossilService,
    private readonly progress: ProgressService,
    private readonly branchesService: BranchesService,
    private readonly notifications: NotificationsService,
    @InjectModel(Source.name)
    private readonly sourceModel: Model<SourceDocument>,
    @InjectModel(SourceRevision.name)
    private readonly sourceRevisionModel: Model<SourceRevisionDocument>
  ) {}

  async uploadRevision(
    workId: string,
    sourceId: string,
    request: UploadSourceRequest,
    file?: Express.Multer.File,
    progressId?: string,
    user?: RequestUser
  ): Promise<UploadSourceResult> {
    if (!file || !file.buffer) {
      throw new BadRequestException('File is required');
    }

    const trimmedWorkId = workId.trim();
    const trimmedSourceId = sourceId.trim();
    const existing = await this.sourceModel.findOne({ workId: trimmedWorkId, sourceId: trimmedSourceId }).lean();
    if (!existing) {
      throw new BadRequestException('Source not found for this work');
    }

    const receivedAt = new Date();
    this.progress.publish(progressId, 'Upload received', 'upload.received');
    const format = this.resolveFormat(file, request.formatHint);
    const label = existing.label; // keep existing label
    const sourceType = existing.sourceType;

    const checksumHex = createHash('sha256').update(file.buffer).digest('hex');
    const storageKey = `${trimmedWorkId}/${trimmedSourceId}/raw/${file.originalname ?? 'upload'}`;

    const storageResult = await this.storageService.putRawObject(
      storageKey,
      file.buffer,
      file.size,
      file.mimetype || 'application/octet-stream'
    );
    this.progress.publish(progressId, 'Stored raw upload', 'upload.stored');

    const storageLocator: StorageLocator = {
      bucket: storageResult.bucket,
      objectKey: storageResult.objectKey,
      sizeBytes: file.size,
      checksum: {
        algorithm: 'sha256',
        hexDigest: checksumHex
      },
      contentType: file.mimetype || 'application/octet-stream',
      lastModifiedAt: receivedAt
    };

    const previousRevision = await this.sourceRevisionModel
      .findOne({ workId: trimmedWorkId, sourceId: trimmedSourceId })
      .sort({ sequenceNumber: -1 })
      .lean();

    const sequenceNumber = (previousRevision?.sequenceNumber ?? 0) + 1;
    // Start with pending; mark as passed once the derivative pipeline completes without pending work
    const validationState: ValidationState = { status: 'pending', issues: [] };

    this.progress.publish(progressId, 'Starting derivative pipeline', 'pipeline.start');
    const derivativeOutcome = await this.derivativePipeline.process({
      workId: trimmedWorkId,
      sourceId: trimmedSourceId,
      sequenceNumber,
      format,
      originalFilename: file.originalname,
      buffer: file.buffer,
      rawStorage: storageLocator,
      previousCanonicalXml: previousRevision?.derivatives?.canonicalXml,
      progressId
    });
    this.progress.publish(progressId, 'Derivative pipeline finished', 'pipeline.done');

    const revisionId = uuidv4();
    const notes = [...derivativeOutcome.notes];
    let pendingStatus = derivativeOutcome.pending;
    let manifest = derivativeOutcome.manifest;
    let manifestData = derivativeOutcome.manifestData;
    let fossilArtifactId: string | undefined;
    let committedBranchName2: string | undefined;
    let committedBranchName: string | undefined;
    const currentCanonical = derivativeOutcome.derivatives.canonicalXml;
    const previousCanonical = previousRevision?.derivatives?.canonicalXml;

    // Derivatives successfully generated -> validation passed
    if (!pendingStatus) {
      validationState.status = 'passed';
      validationState.performedAt = new Date();
    }

    if (!pendingStatus && derivativeOutcome.derivatives.linearizedXml && derivativeOutcome.manifest) {
      try {
        this.progress.publish(progressId, 'Committing to Fossil', 'fossil.start');
        const fossilFiles = await this.collectFossilFiles(derivativeOutcome);
        if (fossilFiles.length > 0) {
          const branch = this.sanitizeBranchName(request.branchName);
          const commit = await this.fossilService.commitRevision({
            workId: trimmedWorkId,
            sourceId: trimmedSourceId,
            revisionId,
            sequenceNumber,
            message: (request.commitMessage?.trim() || label),
            files: fossilFiles,
            branchName: branch
          });
          fossilArtifactId = commit.artifactId;
          committedBranchName = commit.branchName || branch || undefined;
          if (fossilArtifactId) {
            notes.push(`Fossil commit recorded (${fossilArtifactId}).`);
            this.progress.publish(progressId, `Fossil commit recorded (${fossilArtifactId})`, 'fossil.done');
          } else {
            notes.push('Fossil commit completed but artifact identifier was not returned.');
            this.progress.publish(progressId, 'Fossil commit completed; id not returned', 'fossil.noid');
          }
          if (commit.branchName) {
            notes.push(`Committed on branch ${commit.branchName}.`);
          } else if (branch) {
            notes.push(`Committed on branch ${branch}.`);
          }
        } else {
          pendingStatus = true;
          notes.push('Fossil commit skipped (no derivative files available).');
          this.progress.publish(progressId, 'Fossil commit skipped (no files)', 'fossil.skipped');
        }
      } catch (error) {
        pendingStatus = true;
        notes.push(`Fossil commit failed: ${this.readableError(error)}`);
        this.progress.publish(progressId, 'Fossil commit failed', 'fossil.failed');
      }
    } else {
      notes.push('Fossil commit skipped (derivative generation pending).');
      this.progress.publish(progressId, 'Fossil commit skipped (pending)', 'fossil.skipped');
    }

    if (!pendingStatus) {
      validationState.status = 'passed';
    }

    const provenance: Provenance = {
      ingestType: 'manual',
      uploadedAt: receivedAt,
      sourceSystem: request.formatHint ? `hint:${request.formatHint}` : undefined,
      uploadedByUserId: user?.userId,
      uploadedByName: user?.name,
      notes
    };

    // Determine branch policy gating
    const sanitizedBranch = this.sanitizeBranchName(request.branchName) || this.commitBranchFromNotes(notes) || 'main';
    const policy = await this.branchesService.getBranchPolicy(trimmedWorkId, trimmedSourceId, sanitizedBranch);
    let status: 'approved' | 'pending_approval' = 'approved';
    let approval: any = undefined;
    if (policy === 'owner_approval') {
      if (!user || !user.userId) {
        throw new BadRequestException('Authentication required to submit to an owned branch');
      }
      status = 'pending_approval';
      const ownerUserId = await this.branchesService.getBranchOwnerUserId(trimmedWorkId, trimmedSourceId, sanitizedBranch);
      approval = { ownerUserId, requestedAt: receivedAt };
    }

    this.progress.publish(progressId, 'Recording revision metadata', 'db.revision');
    await this.sourceRevisionModel.create({
      workId: trimmedWorkId,
      sourceId: trimmedSourceId,
      revisionId,
      sequenceNumber,
      fossilArtifactId,
      fossilParentArtifactIds:
        previousRevision?.fossilArtifactId != null ? [previousRevision.fossilArtifactId] : [],
      fossilBranch: committedBranchName ?? this.commitBranchFromNotes(notes) ?? undefined,
      branchName: sanitizedBranch,
      rawStorage: storageLocator,
      checksum: storageLocator.checksum,
      createdBy: user?.userId || 'system',
      createdAt: receivedAt,
      validationSnapshot: validationState,
      derivatives: derivativeOutcome.derivatives,
      manifest,
      changeSummary: request.commitMessage?.trim() || 'New revision',
      status,
      approval
    });

    this.progress.publish(progressId, 'Updating source summary', 'db.source');
    const setLatest = status === 'approved';
    await this.sourceModel.updateOne(
      { workId: trimmedWorkId, sourceId: trimmedSourceId },
      {
        $set: {
          description: request.description ?? existing.description,
          format,
          originalFilename: file.originalname,
          storage: storageLocator,
          validation: validationState,
          provenance,
          derivatives: setLatest ? derivativeOutcome.derivatives : (existing.derivatives ?? undefined),
          ...(setLatest ? { latestRevisionId: revisionId, latestRevisionAt: receivedAt } : {})
        }
      }
    );

    const formatsForWork = new Set<string>([format]);
    if (derivativeOutcome.derivatives.normalizedMxl) formatsForWork.add('application/vnd.recordare.musicxml');
    if (derivativeOutcome.derivatives.linearizedXml) formatsForWork.add('text/plain');
    if (derivativeOutcome.derivatives.canonicalXml) formatsForWork.add('application/xml');

    if (setLatest) {
      await this.worksService.recordSourceRevision(trimmedWorkId, Array.from(formatsForWork), receivedAt);
    }
    if (status === 'pending_approval') {
      await this.notifications.queuePushRequest({ workId: trimmedWorkId, sourceId: trimmedSourceId, revisionId, ownerUserId: approval?.ownerUserId });
    }
    // Kick off async musicdiff if we have previous and current canonical
    if (currentCanonical && previousCanonical) {
      this.progress.publish(progressId, 'Queueing musicdiff (async)', 'diff.queued');
      this.generateMusicDiffAsync(
        trimmedWorkId,
        trimmedSourceId,
        revisionId,
        sequenceNumber,
        currentCanonical,
        previousCanonical
      ).catch(() => {});
    }
    this.progress.publish(progressId, 'Done', 'done');
    this.progress.complete(progressId);

    return {
      workId: trimmedWorkId,
      sourceId: trimmedSourceId,
      revisionId,
      status: pendingStatus ? 'pending' : 'accepted',
      message: pendingStatus ? 'Upload stored; additional processing pending.' : 'Upload stored; derivatives generated.',
      receivedBytes: file.size,
      originalFilename: file.originalname,
      mimeType: file.mimetype || 'application/octet-stream',
      notes,
      manifest,
      manifestData
    };
  }
  async upload(
    workId: string,
    request: UploadSourceRequest,
    file?: Express.Multer.File,
    progressId?: string,
    user?: RequestUser
  ): Promise<UploadSourceResult> {
    if (!file || !file.buffer) {
      throw new BadRequestException('File is required');
    }

    const trimmedWorkId = workId.trim();
    const work = await this.worksService.ensureWork(trimmedWorkId);
    const sourceId = uuidv4();
    const receivedAt = new Date();
    this.progress.publish(progressId, 'Upload received', 'upload.received');
    const sourceType = request?.sourceType ?? 'score';
    const label = request.label?.trim() || 'Uploaded source';
    const format = this.resolveFormat(file, request.formatHint);

    const checksumHex = createHash('sha256').update(file.buffer).digest('hex');
    const storageKey = `${work.workId}/${sourceId}/raw/${file.originalname ?? 'upload'}`;

    const storageResult = await this.storageService.putRawObject(
      storageKey,
      file.buffer,
      file.size,
      file.mimetype || 'application/octet-stream'
    );
    this.progress.publish(progressId, 'Stored raw upload', 'upload.stored');

    const storageLocator: StorageLocator = {
      bucket: storageResult.bucket,
      objectKey: storageResult.objectKey,
      sizeBytes: file.size,
      checksum: {
        algorithm: 'sha256',
        hexDigest: checksumHex
      },
      contentType: file.mimetype || 'application/octet-stream',
      lastModifiedAt: receivedAt
    };

    // Start with pending; mark as passed once the derivative pipeline completes without pending work
    const validationState: ValidationState = {
      status: 'pending',
      issues: []
    };

    const previousRevision = await this.sourceRevisionModel
      .findOne({ workId: work.workId, sourceId })
      .sort({ sequenceNumber: -1 })
      .lean();

    const sequenceNumber = (previousRevision?.sequenceNumber ?? 0) + 1;
    this.progress.publish(progressId, 'Starting derivative pipeline', 'pipeline.start');
    const derivativeOutcome = await this.derivativePipeline.process({
      workId: work.workId,
      sourceId,
      sequenceNumber,
      format,
      originalFilename: file.originalname,
      buffer: file.buffer,
      rawStorage: storageLocator,
      previousCanonicalXml: previousRevision?.derivatives?.canonicalXml,
      progressId
    });
    this.progress.publish(progressId, 'Derivative pipeline finished', 'pipeline.done');

    const revisionId = uuidv4();
    const notes = [...derivativeOutcome.notes];
    let pendingStatus = derivativeOutcome.pending;
    let manifest = derivativeOutcome.manifest;
    let manifestData = derivativeOutcome.manifestData;
    let fossilArtifactId: string | undefined;
    const currentCanonical = derivativeOutcome.derivatives.canonicalXml;
    const previousCanonical = previousRevision?.derivatives?.canonicalXml;

    // Derivatives successfully generated -> validation passed
    if (!pendingStatus) {
      validationState.status = 'passed';
      validationState.performedAt = new Date();
    }

    if (
      !pendingStatus &&
      derivativeOutcome.derivatives.linearizedXml &&
      derivativeOutcome.manifest
    ) {
      try {
        this.progress.publish(progressId, 'Committing to Fossil', 'fossil.start');
        const fossilFiles = await this.collectFossilFiles(derivativeOutcome);

        if (fossilFiles.length > 0) {
          const branch = this.sanitizeBranchName(request.branchName);
          const commit = await this.fossilService.commitRevision({
            workId: work.workId,
            sourceId,
            revisionId,
            sequenceNumber,
            message: (request.commitMessage?.trim() || label),
            files: fossilFiles,
            branchName: branch
          });
          fossilArtifactId = commit.artifactId;

          if (fossilArtifactId) {
            notes.push(`Fossil commit recorded (${fossilArtifactId}).`);
            this.progress.publish(progressId, `Fossil commit recorded (${fossilArtifactId})`, 'fossil.done');
          } else {
            notes.push('Fossil commit completed but artifact identifier was not returned.');
            this.progress.publish(progressId, 'Fossil commit completed; id not returned', 'fossil.noid');
          }
        } else {
          pendingStatus = true;
          notes.push('Fossil commit skipped (no derivative files available).');
          this.progress.publish(progressId, 'Fossil commit skipped (no files)', 'fossil.skipped');
        }
      } catch (error) {
        pendingStatus = true;
        notes.push(`Fossil commit failed: ${this.readableError(error)}`);
        this.progress.publish(progressId, 'Fossil commit failed', 'fossil.failed');
      }
    } else {
      notes.push('Fossil commit skipped (derivative generation pending).');
      this.progress.publish(progressId, 'Fossil commit skipped (pending)', 'fossil.skipped');
    }

    // If the pipeline is no longer pending, mark validation as passed for now.
    if (!pendingStatus) {
      validationState.status = 'passed';
    }

    const provenance: Provenance = {
      ingestType: 'manual',
      uploadedAt: receivedAt,
      sourceSystem: request.formatHint ? `hint:${request.formatHint}` : undefined,
      uploadedByUserId: user?.userId,
      uploadedByName: user?.name,
      notes
    };

    // Determine branch policy gating for new source (default to main)
    const sanitizedBranch = this.sanitizeBranchName(request.branchName) || this.commitBranchFromNotes(notes) || 'main';
    await this.branchesService.ensureDefaultMain(work.workId, sourceId);
    const policy = await this.branchesService.getBranchPolicy(work.workId, sourceId, sanitizedBranch);
    let status: 'approved' | 'pending_approval' = 'approved';
    let approval: any = undefined;
    if (policy === 'owner_approval') {
      if (!user || !user.userId) {
        throw new BadRequestException('Authentication required to submit to an owned branch');
      }
      status = 'pending_approval';
      const ownerUserId = await this.branchesService.getBranchOwnerUserId(work.workId, sourceId, sanitizedBranch);
      approval = { ownerUserId, requestedAt: receivedAt };
    }

    this.progress.publish(progressId, 'Recording revision metadata', 'db.revision');
    await this.sourceRevisionModel.create({
      workId: work.workId,
      sourceId,
      revisionId,
      sequenceNumber,
      fossilArtifactId,
      fossilParentArtifactIds:
        previousRevision?.fossilArtifactId != null
          ? [previousRevision.fossilArtifactId]
          : [],
      fossilBranch: sanitizedBranch,
      branchName: sanitizedBranch,
      rawStorage: storageLocator,
      checksum: storageLocator.checksum,
      createdBy: user?.userId || 'system',
      createdAt: receivedAt,
      validationSnapshot: validationState,
      derivatives: derivativeOutcome.derivatives,
      manifest,
      changeSummary: request.commitMessage?.trim() || (sequenceNumber === 1 ? 'Initial upload' : 'New revision'),
      status,
      approval
    });

    this.progress.publish(progressId, 'Creating source record', 'db.source');
    await this.sourceModel.create({
      workId: work.workId,
      sourceId,
      label,
      sourceType,
      format,
      description: request.description,
      license: request.license,
      licenseUrl: request.licenseUrl,
      licenseAttribution: request.licenseAttribution,
      originalFilename: file.originalname,
      isPrimary: request.isPrimary ?? false,
      storage: storageLocator,
      validation: validationState,
      provenance,
      derivatives: status === 'approved' ? derivativeOutcome.derivatives : undefined,
      latestRevisionId: status === 'approved' ? revisionId : undefined,
      latestRevisionAt: status === 'approved' ? receivedAt : undefined
    });

    const formatsForWork = new Set<string>([format]);
    if (derivativeOutcome.derivatives.normalizedMxl) {
      formatsForWork.add('application/vnd.recordare.musicxml');
    }
    if (derivativeOutcome.derivatives.linearizedXml) {
      formatsForWork.add('text/plain');
    }
    if (derivativeOutcome.derivatives.canonicalXml) {
      formatsForWork.add('application/xml');
    }

    if (status === 'approved') {
      await this.worksService.recordSourceUpload(
        work.workId,
        Array.from(formatsForWork),
        receivedAt
      );
    }
    if (status === 'pending_approval') {
      await this.notifications.queuePushRequest({ workId: work.workId, sourceId, revisionId, ownerUserId: approval?.ownerUserId });
    }
    // No previous on brand-new sources; nothing to diff
    this.progress.publish(progressId, 'Done', 'done');
    this.progress.complete(progressId);

    return {
      workId: work.workId,
      sourceId,
      revisionId,
      status: pendingStatus ? 'pending' : 'accepted',
      message: pendingStatus
        ? 'Upload stored; additional processing pending.'
        : 'Upload stored; derivatives generated.',
      receivedBytes: file.size,
      originalFilename: file.originalname,
      mimeType: file.mimetype || 'application/octet-stream',
      notes,
      manifest,
      manifestData
    };
  }

  private async generateMusicDiffAsync(
    workId: string,
    sourceId: string,
    revisionId: string,
    sequenceNumber: number,
    current: StorageLocator,
    previous: StorageLocator
  ): Promise<void> {
    const dir = await fs.mkdtemp(join(tmpdir(), 'ots-mdiff-'));
    try {
      const currentPath = join(dir, 'current.xml');
      const previousPath = join(dir, 'previous.xml');
      const [bufCur, bufPrev] = await Promise.all([
        this.storageService.getObjectBuffer(current.bucket, current.objectKey),
        this.storageService.getObjectBuffer(previous.bucket, previous.objectKey)
      ]);
      await fs.writeFile(currentPath, bufCur);
      await fs.writeFile(previousPath, bufPrev);
      const diff = await this.exec(['python3', '-m', 'musicdiff', '-o=text', '--', previousPath, currentPath]);
      const diffBuffer = Buffer.from(diff, 'utf-8');
      const base = `${workId}/${sourceId}/rev-${sequenceNumber.toString().padStart(4, '0')}`;
      const locator = await this.storageService.putAuxiliaryObject(
        `${base}/musicdiff.txt`,
        diffBuffer,
        diffBuffer.length,
        'text/plain'
      );
      // Visual (PDF) report
      let pdfLocator: { bucket: string; objectKey: string } | undefined = undefined;
      let pdfSize = 0;
      let pdfDigest = '';
      try {
        const pdfBuffer = await this.execBuffer(['python3', '-m', 'musicdiff', '-o=visual', '--', previousPath, currentPath]);
        pdfSize = pdfBuffer.length;
        pdfDigest = createHash('sha256').update(pdfBuffer).digest('hex');
        pdfLocator = await this.storageService.putAuxiliaryObject(
          `${base}/musicdiff.pdf`,
          pdfBuffer,
          pdfBuffer.length,
          'application/pdf'
        );
      } catch {
        // ignore pdf generation failures
      }

      // HTML wrapper that embeds/links the PDF for convenience
      let htmlLocator: { bucket: string; objectKey: string } | undefined = undefined;
      let htmlSize = 0;
      let htmlDigest = '';
      try {
        const pdfUrl = `/api/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/musicdiff.pdf?r=${encodeURIComponent(revisionId)}`;
        const wrapper = `<!doctype html><html><head><meta charset="utf-8"><title>MusicDiff (visual)</title></head><body style="margin:0;padding:0;height:100vh"><object data="${pdfUrl}" type="application/pdf" style="width:100%;height:100%"><p>Open PDF: <a href="${pdfUrl}">${pdfUrl}</a></p></object></body></html>`;
        const htmlBuffer = Buffer.from(wrapper, 'utf-8');
        htmlSize = htmlBuffer.length;
        htmlDigest = createHash('sha256').update(htmlBuffer).digest('hex');
        htmlLocator = await this.storageService.putAuxiliaryObject(
          `${base}/musicdiff.html`,
          htmlBuffer,
          htmlBuffer.length,
          'text/html'
        );
      } catch {
        // ignore wrapper generation failures
      }
      // Update revision derivatives
      await this.sourceRevisionModel.updateOne(
        { workId, sourceId, revisionId },
        { $set: { 'derivatives.musicDiffReport': {
          bucket: locator.bucket,
          objectKey: locator.objectKey,
          sizeBytes: diffBuffer.length,
          checksum: { algorithm: 'sha256', hexDigest: createHash('sha256').update(diffBuffer).digest('hex') },
          contentType: 'text/plain',
          lastModifiedAt: new Date()
        }, ...(htmlLocator ? { 'derivatives.musicDiffHtml': {
          bucket: htmlLocator.bucket,
          objectKey: htmlLocator.objectKey,
          sizeBytes: htmlSize,
          checksum: { algorithm: 'sha256', hexDigest: htmlDigest },
          contentType: 'text/html',
          lastModifiedAt: new Date()
        } } : {}), ...(pdfLocator ? { 'derivatives.musicDiffPdf': {
          bucket: pdfLocator.bucket,
          objectKey: pdfLocator.objectKey,
          sizeBytes: pdfSize,
          checksum: { algorithm: 'sha256', hexDigest: pdfDigest },
          contentType: 'application/pdf',
          lastModifiedAt: new Date()
        } } : {}) } }
      ).exec();
      // Also update source.latest derivatives if this is latest
      await this.sourceModel.updateOne(
        { workId, sourceId, latestRevisionId: revisionId },
        { $set: { 'derivatives.musicDiffReport': {
          bucket: locator.bucket,
          objectKey: locator.objectKey,
          sizeBytes: diffBuffer.length,
          checksum: { algorithm: 'sha256', hexDigest: createHash('sha256').update(diffBuffer).digest('hex') },
          contentType: 'text/plain',
          lastModifiedAt: new Date()
        }, ...(htmlLocator ? { 'derivatives.musicDiffHtml': {
          bucket: htmlLocator.bucket,
          objectKey: htmlLocator.objectKey,
          sizeBytes: htmlSize,
          checksum: { algorithm: 'sha256', hexDigest: htmlDigest },
          contentType: 'text/html',
          lastModifiedAt: new Date()
        } } : {}), ...(pdfLocator ? { 'derivatives.musicDiffPdf': {
          bucket: pdfLocator.bucket,
          objectKey: pdfLocator.objectKey,
          sizeBytes: pdfSize,
          checksum: { algorithm: 'sha256', hexDigest: pdfDigest },
          contentType: 'application/pdf',
          lastModifiedAt: new Date()
        } } : {}) } }
      ).exec();
    } catch (err) {
      // Best effort; swallow errors
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private exec(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (c) => (out += c.toString()));
      child.stderr.on('data', (c) => (err += c.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(out);
        else reject(new Error(err || `command exited with code ${code}`));
      });
    });
  }

  private execBuffer(args: string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let err = '';
      child.stdout.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
      child.stderr.on('data', (c) => (err += c.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(Buffer.concat(chunks));
        else reject(new Error(err || `command exited with code ${code}`));
      });
    });
  }

  private async collectFossilFiles(
    outcome: DerivativePipelineResult
  ): Promise<FossilCommitFile[]> {
    const files: FossilCommitFile[] = [];

    const addFile = async (relativePath: string, locator?: StorageLocator) => {
      if (!locator) {
        return;
      }

      const buffer = await this.storageService.getObjectBuffer(
        locator.bucket,
        locator.objectKey
      );
      files.push({ relativePath, content: buffer });
    };

    await addFile('linearized.lmx', outcome.derivatives.linearizedXml);
    await addFile('canonical.xml', outcome.derivatives.canonicalXml);
    // normalized.mxl is binary; skip committing it to Fossil to avoid
    // binary-file commit guards. It is still stored in object storage.
    await addFile('manifest.json', outcome.manifest);

    return files;
  }

  private readableError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  private commitBranchFromNotes(notes: string[]): string | undefined {
    const match = notes.find((n) => n.startsWith('Committed on branch '));
    if (!match) return undefined;
    const raw = match.replace('Committed on branch ', '').trim();
    // Some notes add a trailing period for readability; strip trailing dots.
    const cleaned = raw.replace(/\.+$/, '');
    return cleaned || undefined;
  }

  private sanitizeBranchName(name?: string): string | undefined {
    const raw = (name ?? '').trim();
    if (!raw) return undefined;
    // replace spaces with dashes and drop invalid characters
    const cleaned = raw.replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
    return cleaned || undefined;
  }

  private resolveFormat(
    file: Express.Multer.File,
    formatHint?: string
  ): string {
    const normalizedHint = formatHint?.toLowerCase();
    if (normalizedHint) {
      if (normalizedHint.includes('mscz')) {
        return 'application/vnd.musescore.mscz';
      }
      if (normalizedHint.includes('mxl')) {
        return 'application/vnd.recordare.musicxml';
      }
      if (normalizedHint.includes('musicxml') || normalizedHint.includes('xml')) {
        return 'application/xml';
      }
    }

    const name = file.originalname?.toLowerCase() ?? '';
    const extension = extname(name);

    switch (extension) {
      case '.mscz':
        return 'application/vnd.musescore.mscz';
      case '.mxl':
        return 'application/vnd.recordare.musicxml';
      case '.xml':
      case '.musicxml':
        return 'application/xml';
      default:
        break;
    }

    const mime = (file.mimetype || '').toLowerCase();
    if (mime.includes('musescore')) {
      return 'application/vnd.musescore.mscz';
    }
    if (
      mime === 'application/vnd.recordare.musicxml' ||
      mime === 'application/vnd.recordare.musicxml+xml'
    ) {
      return 'application/vnd.recordare.musicxml';
    }
    if (mime === 'application/xml' || mime === 'text/xml') {
      return 'application/xml';
    }

    throw new BadRequestException(
      'Unsupported file format. Accepted: .mscz, .mxl, .xml.'
    );
  }
}
