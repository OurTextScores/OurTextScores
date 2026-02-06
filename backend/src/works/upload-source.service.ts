import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { join } from 'node:path';
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
import { ImslpService } from '../imslp/imslp.service';
import type { RequestUser } from '../auth/types/auth-user';

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100MB

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
    private readonly imslpService: ImslpService,
    @InjectModel(Source.name)
    private readonly sourceModel: Model<SourceDocument>,
    @InjectModel(SourceRevision.name)
    private readonly sourceRevisionModel: Model<SourceRevisionDocument>
  ) { }

  async uploadRevision(
    workId: string,
    sourceId: string,
    request: UploadSourceRequest,
    file?: Express.Multer.File,
    referencePdfFile?: Express.Multer.File,
    progressId?: string,
    user?: RequestUser
  ): Promise<UploadSourceResult> {
    if (!file || !file.buffer) {
      throw new BadRequestException('File is required');
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new BadRequestException('File is too large (max 100MB).');
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
    this.handleMuseScoreFailure(format, derivativeOutcome, progressId);
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

    if (!pendingStatus && derivativeOutcome.derivatives.canonicalXml && derivativeOutcome.manifest) {
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

    // Handle reference PDF if provided
    let hasReferencePdf = (existing as any).hasReferencePdf ?? false;
    if (referencePdfFile && referencePdfFile.buffer) {
      try {
        const referencePdfLocator = await this.storeReferencePdf(
          referencePdfFile,
          trimmedWorkId,
          trimmedSourceId,
          sequenceNumber,
          progressId
        );
        if (referencePdfLocator) {
          derivativeOutcome.derivatives.referencePdf = referencePdfLocator;
          hasReferencePdf = true;
          notes.push('Reference PDF stored successfully.');
        }
      } catch (error) {
        notes.push(`Reference PDF storage failed: ${this.readableError(error)}`);
        this.progress.publish(progressId, 'Reference PDF storage failed', 'store.refpdf.failed');
        throw error;
      }
    }

    const existingProvenance = (existing as any).provenance as Provenance | undefined;
    const provenance: Provenance = {
      ingestType: existingProvenance?.ingestType ?? 'manual',
      uploadedAt: receivedAt,
      sourceSystem: existingProvenance?.sourceSystem ?? (request.formatHint ? `hint:${request.formatHint}` : undefined),
      sourceIdentifier: existingProvenance?.sourceIdentifier,
      uploadedByUserId: existingProvenance?.uploadedByUserId ?? user?.userId,
      uploadedByName: existingProvenance?.uploadedByName ?? user?.name,
      notes: Array.isArray(existingProvenance?.notes) ? [...existingProvenance.notes, ...notes] : notes
    };

    // Determine branch policy gating
    const sanitizedBranch = this.sanitizeBranchName(request.branchName) || this.commitBranchFromNotes(notes) || 'trunk';
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
      license: request.license ?? existing.license,
      licenseUrl: request.licenseUrl ?? existing.licenseUrl,
      licenseAttribution: request.licenseAttribution ?? existing.licenseAttribution,
      status,
      approval
    });

    this.progress.publish(progressId, 'Updating source summary', 'db.source');
    const setLatest = status === 'approved';
    if (setLatest) {
      await this.sourceModel.updateOne(
        { workId: trimmedWorkId, sourceId: trimmedSourceId },
        {
          $set: {
            description: request.description ?? existing.description,
            format,
            originalFilename: file.originalname,
            hasReferencePdf,
            storage: storageLocator,
            validation: validationState,
            provenance,
            derivatives: derivativeOutcome.derivatives,
            latestRevisionId: revisionId,
            latestRevisionAt: receivedAt,
            license: request.license ?? existing.license,
            licenseUrl: request.licenseUrl ?? existing.licenseUrl,
            licenseAttribution: request.licenseAttribution ?? existing.licenseAttribution
          }
        }
      );
    }

    const formatsForWork = new Set<string>([format]);
    if (derivativeOutcome.derivatives.normalizedMxl) formatsForWork.add('application/vnd.recordare.musicxml');
    if (derivativeOutcome.derivatives.canonicalXml) formatsForWork.add('application/xml');

    if (setLatest) {
      await this.worksService.recordSourceRevision(trimmedWorkId, Array.from(formatsForWork), receivedAt);
    }
    if (status === 'pending_approval') {
      await this.notifications.queuePushRequest({ workId: trimmedWorkId, sourceId: trimmedSourceId, revisionId, ownerUserId: approval?.ownerUserId });
    }
    this.progress.publish(progressId, 'Done', 'done');

    // Recompute work stats (including hasReferencePdf aggregation)
    await (this.worksService as any).recomputeWorkStats(trimmedWorkId);

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

  async uploadReferencePdf(
    workId: string,
    sourceId: string,
    referencePdfFile?: Express.Multer.File,
    progressId?: string,
    user?: RequestUser
  ): Promise<{ ok: true; referencePdf: StorageLocator; revisionId: string }> {
    if (!referencePdfFile || !referencePdfFile.buffer) {
      throw new BadRequestException('Reference PDF file is required');
    }
    if (!user?.userId) {
      throw new BadRequestException('Authentication required');
    }

    const trimmedWorkId = workId.trim();
    const trimmedSourceId = sourceId.trim();
    const source = await this.sourceModel
      .findOne({ workId: trimmedWorkId, sourceId: trimmedSourceId })
      .lean()
      .exec();

    if (!source) {
      throw new NotFoundException('Source not found for this work');
    }

    if (source.hasReferencePdf || source.derivatives?.referencePdf) {
      throw new BadRequestException('Reference PDF already exists for this source');
    }

    const isAdmin = (user.roles ?? []).includes('admin');
    if (!isAdmin) {
      const ownerUserId = (source as any).provenance?.uploadedByUserId as string | undefined;
      if (!ownerUserId || ownerUserId !== user.userId) {
        throw new ForbiddenException('Only source owner or admin can upload reference PDF');
      }
    }

    let latestRevision = null as any;
    if ((source as any).latestRevisionId) {
      latestRevision = await this.sourceRevisionModel
        .findOne({ workId: trimmedWorkId, sourceId: trimmedSourceId, revisionId: (source as any).latestRevisionId })
        .lean()
        .exec();
    }
    if (!latestRevision) {
      latestRevision = await this.sourceRevisionModel
        .findOne({ workId: trimmedWorkId, sourceId: trimmedSourceId })
        .sort({ sequenceNumber: -1 })
        .lean()
        .exec();
    }

    if (!latestRevision) {
      throw new BadRequestException('No revisions found for this source');
    }

    const referencePdfLocator = await this.storeReferencePdf(
      referencePdfFile,
      trimmedWorkId,
      trimmedSourceId,
      latestRevision.sequenceNumber,
      progressId
    );
    if (!referencePdfLocator) {
      throw new BadRequestException('Reference PDF could not be stored');
    }

    await this.sourceModel
      .updateOne(
        { workId: trimmedWorkId, sourceId: trimmedSourceId },
        { $set: { hasReferencePdf: true, 'derivatives.referencePdf': referencePdfLocator } }
      )
      .exec();

    await this.sourceRevisionModel
      .updateOne(
        { workId: trimmedWorkId, sourceId: trimmedSourceId, revisionId: latestRevision.revisionId },
        { $set: { 'derivatives.referencePdf': referencePdfLocator } }
      )
      .exec();

    await (this.worksService as any).recomputeWorkStats(trimmedWorkId);

    return { ok: true, referencePdf: referencePdfLocator, revisionId: latestRevision.revisionId };
  }
  async upload(
    workId: string,
    request: UploadSourceRequest,
    file?: Express.Multer.File,
    referencePdfFile?: Express.Multer.File,
    progressId?: string,
    user?: RequestUser
  ): Promise<UploadSourceResult> {
    if (!file || !file.buffer) {
      throw new BadRequestException('File is required');
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new BadRequestException('File is too large (max 100MB).');
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
    this.handleMuseScoreFailure(format, derivativeOutcome, progressId);
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
      derivativeOutcome.derivatives.canonicalXml &&
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

    // Handle reference PDF if provided
    let hasReferencePdf = false;
    if (referencePdfFile && referencePdfFile.buffer) {
      try {
        const referencePdfLocator = await this.storeReferencePdf(
          referencePdfFile,
          work.workId,
          sourceId,
          sequenceNumber,
          progressId
        );
        if (referencePdfLocator) {
          derivativeOutcome.derivatives.referencePdf = referencePdfLocator;
          hasReferencePdf = true;
          notes.push('Reference PDF stored successfully.');
        }
      } catch (error) {
        notes.push(`Reference PDF storage failed: ${this.readableError(error)}`);
        this.progress.publish(progressId, 'Reference PDF storage failed', 'store.refpdf.failed');
        throw error;
      }
    }

    const provenance: Provenance = {
      ingestType: 'manual',
      uploadedAt: receivedAt,
      sourceSystem: request.formatHint ? `hint:${request.formatHint}` : undefined,
      uploadedByUserId: user?.userId,
      uploadedByName: user?.name,
      notes
    };

    // Determine branch policy gating for new source (default to trunk)
    const sanitizedBranch = this.sanitizeBranchName(request.branchName) || this.commitBranchFromNotes(notes) || 'trunk';
    await this.branchesService.ensureDefaultTrunk(work.workId, sourceId);
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
      license: request.license,
      licenseUrl: request.licenseUrl,
      licenseAttribution: request.licenseAttribution,
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
      hasReferencePdf,
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

    // Recompute work stats (including hasReferencePdf aggregation)
    await (this.worksService as any).recomputeWorkStats(trimmedWorkId);

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

    await addFile('canonical.xml', outcome.derivatives.canonicalXml);
    // normalized.mxl is binary; skip committing it to Fossil to avoid
    // binary-file commit guards. It is still stored in object storage.
    await addFile('manifest.json', outcome.manifest);

    return files;
  }

  private handleMuseScoreFailure(
    format: string,
    outcome: DerivativePipelineResult,
    progressId?: string
  ): void {
    if (format !== 'application/vnd.musescore.mscz' && format !== 'application/vnd.musescore.mscx') {
      return;
    }

    const missingCore =
      !outcome.derivatives?.canonicalXml;
    if (!outcome.pending && !missingCore) {
      return;
    }
    const lastNote = outcome.notes[outcome.notes.length - 1] ?? '';
    let message =
      'Could not process MuseScore file. Please export the score as MusicXML (.mxl or .xml) in MuseScore and upload that file instead.';

    const lower = lastNote.toLowerCase();
    if (lower.includes('newer version of musescore')) {
      message =
        'Could not process MuseScore file: this score was saved with a newer version of MuseScore than the server supports. Please export it as MusicXML (.mxl or .xml) and upload that file instead.';
    }

    this.progress.publish(
      progressId,
      'Derivative pipeline failed for MuseScore file',
      'pipeline.error'
    );
    this.progress.publish(progressId, 'Done', 'done');
    this.progress.complete(progressId);

    throw new BadRequestException(message);
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
      if (normalizedHint.includes('mscx')) {
        return 'application/vnd.musescore.mscx';
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
      case '.mscx':
        return 'application/vnd.musescore.mscx';
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
      if (name.endsWith('.mscx')) {
        return 'application/vnd.musescore.mscx';
      }
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
      'Unsupported file format. Accepted: .mscz, .mscx, .mxl, .xml.'
    );
  }

  private async storeReferencePdf(
    referencePdfFile: Express.Multer.File,
    workId: string,
    sourceId: string,
    sequenceNumber: number,
    progressId?: string
  ): Promise<StorageLocator | undefined> {
    // Validate PDF type and size
    const MAX_PDF_SIZE = 50 * 1024 * 1024; // 50 MB
    if (referencePdfFile.size > MAX_PDF_SIZE) {
      throw new BadRequestException('Reference PDF is too large (max 50MB)');
    }

    const mime = (referencePdfFile.mimetype || '').toLowerCase();
    if (mime !== 'application/pdf') {
      throw new BadRequestException('Reference file must be a PDF');
    }

    const ext = extname(referencePdfFile.originalname?.toLowerCase() ?? '');
    if (ext && ext !== '.pdf') {
      throw new BadRequestException('Reference file must have .pdf extension');
    }

    const validation = await this.validateReferencePdfAgainstImslp(referencePdfFile, workId);
    if (validation.valid === false) {
      throw new BadRequestException(validation.reason);
    }

    this.progress.publish(progressId, 'Storing reference PDF', 'store.refpdf');

    const base = `${workId}/${sourceId}/rev-${sequenceNumber.toString().padStart(4, '0')}`;
    const storageKey = `${base}/reference.pdf`;

    const checksumHex = createHash('sha256').update(referencePdfFile.buffer).digest('hex');

    const storageResult = await this.storageService.putAuxiliaryObject(
      storageKey,
      referencePdfFile.buffer,
      referencePdfFile.size,
      'application/pdf'
    );

    const storageLocator: StorageLocator = {
      bucket: storageResult.bucket,
      objectKey: storageResult.objectKey,
      sizeBytes: referencePdfFile.size,
      checksum: {
        algorithm: 'sha256',
        hexDigest: checksumHex
      },
      contentType: 'application/pdf',
      lastModifiedAt: new Date(),
      metadata: {
        imslpSource: validation.imslpFile
      }
    };

    return storageLocator;
  }

  private async validateReferencePdfAgainstImslp(
    file: Express.Multer.File,
    workId: string
  ): Promise<{ valid: true; imslpFile: { name: string; title: string; url: string; sha1: string; size: number; timestamp: string; user: string } } | { valid: false; reason: string }> {
    const hash = createHash('sha1').update(file.buffer).digest('hex');
    const imslpData = await this.imslpService.getRawByWorkId(workId).catch(() => null);
    if (!imslpData) {
      return { valid: false, reason: 'IMSLP metadata not available for this work' };
    }

    const metadata = (imslpData.metadata as Record<string, unknown>) ?? {};
    const files = (metadata['files'] as Array<Record<string, unknown>>) ?? [];

    const pdfFiles = files.filter((f) => {
      const mimeType = String(f['mime_type'] ?? '').toLowerCase();
      const name = String(f['name'] ?? '').toLowerCase();
      return mimeType === 'application/pdf' || mimeType.includes('pdf') || name.endsWith('.pdf');
    });

    if (pdfFiles.length === 0) {
      return { valid: false, reason: 'No PDF files found in IMSLP metadata for this work' };
    }

    const matchingFile = pdfFiles.find((f) => {
      const imslpSha1 = String(f['sha1'] ?? '').toLowerCase();
      return imslpSha1 && imslpSha1 === hash.toLowerCase();
    });

    if (!matchingFile) {
      return {
        valid: false,
        reason: `PDF does not match any IMSLP source (${pdfFiles.length} PDFs available). Please download from IMSLP.`
      };
    }

    return {
      valid: true,
      imslpFile: {
        name: String(matchingFile['name'] ?? ''),
        title: String(matchingFile['title'] ?? ''),
        url: String(matchingFile['url'] ?? ''),
        sha1: String(matchingFile['sha1'] ?? ''),
        size: Number(matchingFile['size'] ?? 0),
        timestamp: String(matchingFile['timestamp'] ?? ''),
        user: String(matchingFile['user'] ?? '')
      }
    };
  }
}
