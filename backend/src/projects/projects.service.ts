import {
  BadRequestException,
  ConflictException,
  Inject,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { Project, ProjectDocument } from './schemas/project.schema';
import { ProjectSourceRow, ProjectSourceRowDocument } from './schemas/project-source-row.schema';
import { Source, SourceDocument } from '../works/schemas/source.schema';
import { Work, WorkDocument } from '../works/schemas/work.schema';
import type { UploadSourceRequest, UploadSourceService } from '../works/upload-source.service';
import { User, UserDocument } from '../users/schemas/user.schema';
import { WorksService } from '../works/works.service';

export const UPLOAD_SOURCE_SERVICE = 'UPLOAD_SOURCE_SERVICE';

interface Actor {
  userId: string;
  roles?: string[];
}

interface UserRefView {
  userId: string;
  username?: string;
  displayName?: string;
}

interface ProjectDocLean {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  leadUserId: string;
  memberUserIds: string[];
  visibility: 'public' | 'private';
  status: 'active' | 'archived';
  rowCount: number;
  linkedSourceCount: number;
  createdBy: string;
  spreadsheetProvider?: 'google';
  spreadsheetEmbedUrl?: string;
  spreadsheetExternalUrl?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

@Injectable()
export class ProjectsService {
  constructor(
    @InjectModel(Project.name)
    private readonly projectModel: Model<ProjectDocument>,
    @InjectModel(ProjectSourceRow.name)
    private readonly rowModel: Model<ProjectSourceRowDocument>,
    @InjectModel(Source.name)
    private readonly sourceModel: Model<SourceDocument>,
    @InjectModel(Work.name)
    private readonly workModel: Model<WorkDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    private readonly worksService: WorksService,
    @Inject(UPLOAD_SOURCE_SERVICE)
    private readonly uploadSourceService: Pick<UploadSourceService, 'upload'>
  ) {}

  async listProjects(
    options?: { limit?: number; offset?: number; status?: string; q?: string },
    actor?: { userId?: string; roles?: string[] }
  ) {
    const limit = Math.max(1, Math.min(options?.limit ?? 20, 100));
    const offset = Math.max(0, options?.offset ?? 0);
    const status = options?.status === 'archived' ? 'archived' : options?.status === 'active' ? 'active' : undefined;
    const q = options?.q?.trim();

    const query: Record<string, unknown> = {};
    if (status) query.status = status;

    if (q) {
      const regex = new RegExp(this.escapeRegex(q), 'i');
      query.$or = [{ title: regex }, { slug: regex }, { description: regex }];
    }

    if (!(actor?.roles ?? []).includes('admin')) {
      if (actor?.userId) {
        query.$and = [
          {
            $or: [
              { visibility: 'public' },
              { leadUserId: actor.userId },
              { memberUserIds: actor.userId }
            ]
          }
        ];
      } else {
        query.visibility = 'public';
      }
    }

    const [total, docs] = await Promise.all([
      this.projectModel.countDocuments(query).exec(),
      this.projectModel
        .find(query)
        .sort({ updatedAt: -1, projectId: 1 })
        .skip(offset)
        .limit(limit)
        .lean()
        .exec()
    ]);

    const enriched = await this.withUserRefs(docs as unknown as ProjectDocLean[]);
    return { projects: enriched, total, limit, offset };
  }

  async createProject(
    payload: {
      title: string;
      slug?: string;
      description?: string;
      leadUserId?: string;
      memberUserIds?: string[];
      visibility?: 'public' | 'private';
      spreadsheetProvider?: 'google';
      spreadsheetEmbedUrl?: string;
      spreadsheetExternalUrl?: string;
    },
    actor: Actor
  ) {
    const title = (payload.title || '').trim();
    if (!title) {
      throw new BadRequestException('title is required');
    }

    const leadUserId = (payload.leadUserId || actor.userId || '').trim();
    if (!leadUserId) {
      throw new BadRequestException('leadUserId is required');
    }

    const slug = await this.generateUniqueSlug(payload.slug || title);
    const projectId = await this.generateUniqueId(this.projectModel, 'projectId', 'prj');

    const memberUserIds = this.normalizeUserIds(payload.memberUserIds).filter((id) => id !== leadUserId);
    const spreadsheetProvider = this.normalizeSpreadsheetProvider(payload.spreadsheetProvider);
    const spreadsheetEmbedUrl = this.normalizeUrl(payload.spreadsheetEmbedUrl, 'spreadsheetEmbedUrl');
    const spreadsheetExternalUrl = this.normalizeUrl(payload.spreadsheetExternalUrl, 'spreadsheetExternalUrl');

    try {
      const created = await this.projectModel.create({
        projectId,
        slug,
        title,
        description: (payload.description || '').trim(),
        leadUserId,
        memberUserIds,
        visibility: payload.visibility === 'private' ? 'private' : 'public',
        status: 'active',
        rowCount: 0,
        linkedSourceCount: 0,
        createdBy: actor.userId,
        spreadsheetProvider,
        spreadsheetEmbedUrl,
        spreadsheetExternalUrl
      });
      const [view] = await this.withUserRefs([created.toObject() as unknown as ProjectDocLean]);
      return view;
    } catch (error: any) {
      if (error?.code === 11000) {
        throw new ConflictException('project slug or projectId already exists');
      }
      throw error;
    }
  }

  async getProject(projectId: string, actor?: { userId?: string; roles?: string[] }) {
    const project = await this.projectModel.findOne({ projectId }).lean().exec();
    if (!project) {
      throw new NotFoundException('project not found');
    }
    this.assertCanRead(project as unknown as ProjectDocLean, actor);
    const [view] = await this.withUserRefs([project as unknown as ProjectDocLean]);
    return view;
  }

  async updateProject(
    projectId: string,
    payload: {
      title?: string;
      description?: string;
      leadUserId?: string;
      status?: 'active' | 'archived';
      visibility?: 'public' | 'private';
      spreadsheetProvider?: 'google' | null;
      spreadsheetEmbedUrl?: string | null;
      spreadsheetExternalUrl?: string | null;
    },
    actor: Actor
  ) {
    const project = await this.getProjectDoc(projectId);
    this.assertCanEditProject(project, actor);

    const set: Record<string, unknown> = {};
    if (payload.title !== undefined) {
      const title = payload.title.trim();
      if (!title) throw new BadRequestException('title cannot be empty');
      set.title = title;
    }
    if (payload.description !== undefined) {
      set.description = payload.description.trim();
    }
    if (payload.leadUserId !== undefined) {
      const nextLead = payload.leadUserId.trim();
      if (!nextLead) throw new BadRequestException('leadUserId cannot be empty');
      set.leadUserId = nextLead;
      const members = (project.memberUserIds ?? []).filter((id) => id !== nextLead);
      set.memberUserIds = members;
    }
    if (payload.status !== undefined) {
      if (payload.status !== 'active' && payload.status !== 'archived') {
        throw new BadRequestException('invalid status');
      }
      set.status = payload.status;
    }
    if (payload.visibility !== undefined) {
      if (payload.visibility !== 'public' && payload.visibility !== 'private') {
        throw new BadRequestException('invalid visibility');
      }
      set.visibility = payload.visibility;
    }
    if (payload.spreadsheetProvider !== undefined) {
      set.spreadsheetProvider = this.normalizeSpreadsheetProvider(payload.spreadsheetProvider ?? undefined);
    }
    if (payload.spreadsheetEmbedUrl !== undefined) {
      set.spreadsheetEmbedUrl = this.normalizeUrl(payload.spreadsheetEmbedUrl ?? undefined, 'spreadsheetEmbedUrl');
    }
    if (payload.spreadsheetExternalUrl !== undefined) {
      set.spreadsheetExternalUrl = this.normalizeUrl(payload.spreadsheetExternalUrl ?? undefined, 'spreadsheetExternalUrl');
    }

    const updated = await this.projectModel.findOneAndUpdate(
      { projectId },
      { $set: set },
      { new: true }
    ).lean().exec();
    if (!updated) throw new NotFoundException('project not found');

    const [view] = await this.withUserRefs([updated as unknown as ProjectDocLean]);
    return view;
  }

  async updateMembers(
    projectId: string,
    payload: { addUserIds?: string[]; removeUserIds?: string[] },
    actor: Actor
  ) {
    const project = await this.getProjectDoc(projectId);
    this.assertCanEditProject(project, actor);

    const add = this.normalizeUserIds(payload.addUserIds);
    const remove = new Set(this.normalizeUserIds(payload.removeUserIds));

    const members = new Set(project.memberUserIds ?? []);
    for (const id of add) {
      if (id !== project.leadUserId) members.add(id);
    }
    for (const id of remove) {
      members.delete(id);
    }

    const updated = await this.projectModel.findOneAndUpdate(
      { projectId },
      { $set: { memberUserIds: Array.from(members).sort() } },
      { new: true }
    ).lean().exec();

    if (!updated) throw new NotFoundException('project not found');
    const [view] = await this.withUserRefs([updated as unknown as ProjectDocLean]);
    return view;
  }

  async archiveProject(projectId: string, actor: Actor) {
    const project = await this.getProjectDoc(projectId);
    this.assertCanEditProject(project, actor);

    const updated = await this.projectModel.findOneAndUpdate(
      { projectId },
      { $set: { status: 'archived' } },
      { new: true }
    ).lean().exec();

    if (!updated) throw new NotFoundException('project not found');
    const [view] = await this.withUserRefs([updated as unknown as ProjectDocLean]);
    return view;
  }

  async joinProject(projectId: string, actor: Actor) {
    const project = await this.getProjectDoc(projectId);
    if (project.status !== 'active') {
      throw new ForbiddenException('Only active projects can be joined');
    }
    if (project.visibility === 'private' && !this.isAdmin(actor)) {
      throw new ForbiddenException('Private projects cannot be joined directly');
    }
    if (project.leadUserId === actor.userId || (project.memberUserIds ?? []).includes(actor.userId)) {
      const [view] = await this.withUserRefs([project]);
      return view;
    }

    const updated = await this.projectModel.findOneAndUpdate(
      { projectId },
      { $addToSet: { memberUserIds: actor.userId } },
      { new: true }
    ).lean().exec();

    if (!updated) throw new NotFoundException('project not found');
    const [view] = await this.withUserRefs([updated as unknown as ProjectDocLean]);
    return view;
  }

  async listSources(
    projectId: string,
    options?: { limit?: number; offset?: number },
    actor?: { userId?: string; roles?: string[] }
  ) {
    const project = await this.getProjectDoc(projectId);
    this.assertCanRead(project, actor);

    const limit = Math.max(1, Math.min(options?.limit ?? 20, 100));
    const offset = Math.max(0, options?.offset ?? 0);

    const [total, docs] = await Promise.all([
      this.sourceModel.countDocuments({ projectIds: projectId }).exec(),
      this.sourceModel
        .find({ projectIds: projectId })
        .sort({ latestRevisionAt: -1, sourceId: 1 })
        .skip(offset)
        .limit(limit)
        .lean()
        .exec()
    ]);

    const workIds = Array.from(new Set(docs.map((doc: any) => String(doc.workId || '')).filter(Boolean)));
    const works = workIds.length > 0
      ? await this.workModel
          .find({ workId: { $in: workIds } })
          .select('workId title composer catalogNumber')
          .lean()
          .exec()
      : [];

    for (const work of works as any[]) {
      if (work?.workId && (!work.title || !work.composer)) {
        try {
          await this.worksService.ensureWorkWithMetadata(String(work.workId));
        } catch {
          // Best-effort hydration only.
        }
      }
    }

    const hydratedWorks = workIds.length > 0
      ? await this.workModel
          .find({ workId: { $in: workIds } })
          .select('workId title composer catalogNumber')
          .lean()
          .exec()
      : [];
    const workById = new Map<string, any>();
    for (const work of hydratedWorks as any[]) {
      workById.set(String(work.workId), work);
    }

    const userIds = Array.from(
      new Set(
        docs
          .map((doc: any) => String(doc?.provenance?.uploadedByUserId || ''))
          .filter(Boolean)
      )
    );
    const users = userIds.length > 0
      ? await this.userModel
          .find({ _id: { $in: userIds } })
          .select('_id username displayName')
          .lean()
          .exec()
      : [];
    const userById = new Map<string, { username?: string; displayName?: string }>();
    for (const user of users as any[]) {
      userById.set(String(user._id), {
        username: user.username ?? undefined,
        displayName: user.displayName ?? undefined
      });
    }

    const sources = (docs as any[]).map((source) => {
      const work = workById.get(String(source.workId));
      const uploaderUserId = source?.provenance?.uploadedByUserId as string | undefined;
      const uploader = uploaderUserId ? userById.get(uploaderUserId) : undefined;
      return {
        workId: source.workId,
        sourceId: source.sourceId,
        label: source.label,
        sourceType: source.sourceType,
        format: source.format,
        description: source.description,
        originalFilename: source.originalFilename,
        hasReferencePdf: source.hasReferencePdf === true,
        adminVerified: source.adminVerified === true,
        projectIds: Array.isArray(source.projectIds) ? source.projectIds : [],
        latestRevisionId: source.latestRevisionId,
        latestRevisionAt: source.latestRevisionAt,
        uploadedByUserId: uploaderUserId,
        uploadedByUsername: uploader?.username,
        uploadedByDisplayName: uploader?.displayName,
        title: work?.title,
        composer: work?.composer,
        catalogNumber: work?.catalogNumber
      };
    });

    return { sources, total, limit, offset };
  }

  async removeSource(projectId: string, sourceId: string, actor: Actor) {
    const project = await this.getProjectDoc(projectId);
    this.assertCanManageProjectSources(project, actor);

    const source = await this.sourceModel.findOne({ sourceId }).lean().exec();
    if (!source) throw new NotFoundException('source not found');

    const currentProjectIds = Array.isArray((source as any).projectIds) ? ((source as any).projectIds as string[]) : [];
    if (!currentProjectIds.includes(projectId)) {
      return { ok: true };
    }

    const nextProjectIds = currentProjectIds.filter((id) => id !== projectId);
    await this.sourceModel.updateOne(
      { sourceId },
      {
        $set: { projectLinkCount: nextProjectIds.length },
        $pull: { projectIds: projectId }
      }
    ).exec();

    await this.refreshProjectCounts(projectId);
    return { ok: true };
  }

  async uploadSource(
    projectId: string,
    payload: {
      workId?: string;
      imslpUrl?: string;
      label?: string;
      sourceType?: 'score' | 'parts' | 'audio' | 'metadata' | 'other';
      description?: string;
      license?: string;
      licenseUrl?: string;
      licenseAttribution?: string;
      rightsDeclarationAccepted?: boolean;
      commitMessage?: string;
      isPrimary?: boolean;
      formatHint?: string;
      createBranch?: boolean;
      branchName?: string;
    },
    file?: Express.Multer.File,
    referencePdfFile?: Express.Multer.File,
    originalMsczFile?: Express.Multer.File,
    progressId?: string,
    actor?: { userId?: string; roles?: string[]; name?: string; email?: string }
  ) {
    if (!actor?.userId) {
      throw new BadRequestException('Authentication required');
    }
    const project = await this.getProjectDoc(projectId);
    this.assertCanEditRows(project, { userId: actor.userId, roles: actor.roles });

    const resolvedWorkId = await this.resolveWorkId({
      workId: payload.workId,
      imslpUrl: payload.imslpUrl
    });

    const uploadPayload: UploadSourceRequest = {
      label: payload.label,
      sourceType: payload.sourceType,
      description: payload.description,
      license: payload.license,
      licenseUrl: payload.licenseUrl,
      licenseAttribution: payload.licenseAttribution,
      rightsDeclarationAccepted: payload.rightsDeclarationAccepted,
      isPrimary: payload.isPrimary,
      formatHint: payload.formatHint,
      commitMessage: payload.commitMessage,
      createBranch: payload.createBranch,
      branchName: payload.branchName
    };

    const result = await this.uploadSourceService.upload(
      resolvedWorkId,
      uploadPayload,
      file,
      referencePdfFile,
      progressId,
      {
        userId: actor.userId,
        roles: actor.roles ?? [],
        name: actor.name,
        email: actor.email
      } as any,
      originalMsczFile
    );

    await this.sourceModel.updateOne(
      { workId: result.workId, sourceId: result.sourceId },
      { $addToSet: { projectIds: projectId } }
    ).exec();

    const linkedSource = await this.sourceModel.findOne({ workId: result.workId, sourceId: result.sourceId }).select('projectIds').lean().exec();
    const projectIds = Array.isArray((linkedSource as any)?.projectIds) ? (linkedSource as any).projectIds : [];
    await this.sourceModel.updateOne(
      { workId: result.workId, sourceId: result.sourceId },
      { $set: { projectLinkCount: projectIds.length } }
    ).exec();

    await this.refreshProjectCounts(projectId);
    return result;
  }

  async listRows(projectId: string, options?: { limit?: number; offset?: number }, actor?: { userId?: string; roles?: string[] }) {
    const project = await this.getProjectDoc(projectId);
    this.assertCanRead(project, actor);

    const limit = Math.max(1, Math.min(options?.limit ?? 50, 200));
    const offset = Math.max(0, options?.offset ?? 0);

    const [total, rows] = await Promise.all([
      this.rowModel.countDocuments({ projectId }).exec(),
      this.rowModel
        .find({ projectId })
        .sort({ createdAt: 1 })
        .skip(offset)
        .limit(limit)
        .lean()
        .exec()
    ]);

    return {
      rows,
      total,
      limit,
      offset
    };
  }

  async createRow(
    projectId: string,
    payload: { externalScoreUrl?: string; imslpUrl?: string; hasReferencePdf?: boolean; notes?: string },
    actor: Actor
  ) {
    const project = await this.getProjectDoc(projectId);
    this.assertCanEditRows(project, actor);

    const externalScoreUrl = this.normalizeUrl(payload.externalScoreUrl, 'externalScoreUrl');
    const imslpUrl = this.normalizeUrl(payload.imslpUrl, 'imslpUrl');
    const notes = payload.notes?.trim();
    if (notes && notes.length > 2000) {
      throw new BadRequestException('notes too long (max 2000 chars)');
    }

    await this.assertNoDuplicateRow(projectId, externalScoreUrl, imslpUrl);

    const rowId = await this.generateUniqueId(this.rowModel, 'rowId', 'row');

    const row = await this.rowModel.create({
      projectId,
      rowId,
      externalScoreUrl,
      imslpUrl,
      hasReferencePdf: payload.hasReferencePdf === true,
      verified: false,
      notes,
      createdBy: actor.userId,
      updatedBy: actor.userId,
      rowVersion: 1
    });

    await this.refreshProjectCounts(projectId);
    return row.toObject();
  }

  async updateRow(
    projectId: string,
    rowId: string,
    payload: {
      rowVersion?: number;
      externalScoreUrl?: string | null;
      imslpUrl?: string | null;
      hasReferencePdf?: boolean;
      verified?: boolean;
      notes?: string | null;
    },
    actor: Actor
  ) {
    const project = await this.getProjectDoc(projectId);
    this.assertCanEditRows(project, actor);

    if (typeof payload.rowVersion !== 'number' || payload.rowVersion < 1) {
      throw new BadRequestException('rowVersion is required');
    }

    const row = await this.rowModel.findOne({ projectId, rowId }).lean().exec();
    if (!row) throw new NotFoundException('row not found');

    const set: Record<string, unknown> = {
      updatedBy: actor.userId,
      updatedAt: new Date()
    };

    const externalScoreUrl = payload.externalScoreUrl !== undefined
      ? this.normalizeUrl(payload.externalScoreUrl ?? undefined, 'externalScoreUrl')
      : row.externalScoreUrl;
    const imslpUrl = payload.imslpUrl !== undefined
      ? this.normalizeUrl(payload.imslpUrl ?? undefined, 'imslpUrl')
      : row.imslpUrl;

    if (payload.externalScoreUrl !== undefined) {
      set.externalScoreUrl = externalScoreUrl;
    }
    if (payload.imslpUrl !== undefined) {
      set.imslpUrl = imslpUrl;
    }

    if (payload.notes !== undefined) {
      const notes = (payload.notes ?? '').trim();
      if (notes.length > 2000) {
        throw new BadRequestException('notes too long (max 2000 chars)');
      }
      set.notes = notes || undefined;
    }

    if (payload.hasReferencePdf !== undefined) {
      set.hasReferencePdf = payload.hasReferencePdf === true;
    }

    if (payload.verified !== undefined && payload.verified !== row.verified) {
      const canVerify = await this.canToggleVerified(project, row, actor);
      if (!canVerify) {
        throw new ForbiddenException('Only source owner, project lead, or admin can change verified');
      }

      set.verified = payload.verified;
      if (payload.verified) {
        set.verifiedAt = new Date();
        set.verifiedBy = actor.userId;
      } else {
        set.verifiedAt = undefined;
        set.verifiedBy = undefined;
      }
    }

    await this.assertNoDuplicateRow(projectId, externalScoreUrl, imslpUrl, rowId);

    const updated = await this.rowModel.findOneAndUpdate(
      { projectId, rowId, rowVersion: payload.rowVersion },
      {
        $set: set,
        $inc: { rowVersion: 1 }
      },
      { new: true }
    ).lean().exec();

    if (!updated) {
      throw new ConflictException('row update conflict; reload and retry');
    }

    return updated;
  }

  async deleteRow(projectId: string, rowId: string, actor: Actor) {
    const project = await this.getProjectDoc(projectId);
    this.assertCanEditRows(project, actor);

    const deleted = await this.rowModel.findOneAndDelete({ projectId, rowId }).lean().exec();
    if (!deleted) throw new NotFoundException('row not found');

    await this.refreshProjectCounts(projectId);
    return { ok: true };
  }

  async createInternalSource(
    projectId: string,
    rowId: string,
    payload: { workId?: string; imslpUrl?: string; sourceId?: string; sourceLabel?: string; sourceType?: 'score' | 'parts' | 'audio' | 'metadata' | 'other' },
    actor: Actor
  ) {
    const project = await this.getProjectDoc(projectId);
    this.assertCanEditRows(project, actor);

    const row = await this.rowModel.findOne({ projectId, rowId }).lean().exec();
    if (!row) throw new NotFoundException('row not found');

    if (row.linkedWorkId && row.linkedSourceId) {
      return {
        ok: true,
        workId: row.linkedWorkId,
        sourceId: row.linkedSourceId,
        revisionId: row.linkedRevisionId,
        row
      };
    }

    const resolvedWorkId = await this.resolveWorkIdForRow(payload, row);

    await this.workModel.findOneAndUpdate(
      { workId: resolvedWorkId },
      {
        $setOnInsert: {
          workId: resolvedWorkId,
          sourceCount: 0,
          availableFormats: [],
          hasReferencePdf: false,
          hasVerifiedSources: false,
          hasFlaggedSources: false
        }
      },
      { upsert: true, new: true }
    ).exec();

    let sourceId = payload.sourceId?.trim();
    if (sourceId) {
      const existing = await this.sourceModel.findOne({ workId: resolvedWorkId, sourceId }).lean().exec();
      if (!existing) {
        throw new NotFoundException('sourceId not found for the target work');
      }
    } else {
      sourceId = await this.generateUniqueId(this.sourceModel, 'sourceId', 'src');
      const now = new Date();
      const zeroChecksum = '0'.repeat(64);

      const sourceType = payload.sourceType ?? 'score';
      const sourceLabel = payload.sourceLabel?.trim() || this.defaultSourceLabel(project.title, row.rowId, row.externalScoreUrl);
      const format = 'application/octet-stream';
      const external = row.externalScoreUrl ? this.safeUrl(row.externalScoreUrl) : undefined;
      const fallbackName = external ? decodeURIComponent(external.pathname.split('/').filter(Boolean).pop() || 'external-link') : 'external-link';
      const sourceDescription = this.buildSourceDescription(row.notes, row.externalScoreUrl, row.imslpUrl);

      await this.sourceModel.create({
        workId: resolvedWorkId,
        sourceId,
        label: sourceLabel,
        sourceType,
        format,
        description: sourceDescription,
        originalFilename: fallbackName,
        isPrimary: false,
        hasReferencePdf: row.hasReferencePdf === true,
        storage: {
          bucket: 'auxiliary',
          objectKey: `projects/${projectId}/${rowId}/placeholder`,
          sizeBytes: 0,
          checksum: { algorithm: 'sha256', hexDigest: zeroChecksum },
          contentType: 'application/octet-stream',
          lastModifiedAt: now
        },
        validation: {
          status: 'pending',
          issues: []
        },
        provenance: {
          ingestType: 'manual',
          sourceSystem: 'project',
          sourceIdentifier: rowId,
          uploadedByUserId: actor.userId,
          uploadedAt: now,
          notes: [
            `Created from project ${projectId} row ${rowId}`,
            row.externalScoreUrl ? `external: ${row.externalScoreUrl}` : '',
            row.imslpUrl ? `imslp: ${row.imslpUrl}` : ''
          ].filter(Boolean)
        },
        projectIds: [projectId],
        projectLinkCount: 1
      });

      await this.workModel.updateOne(
        { workId: resolvedWorkId },
        {
          $inc: { sourceCount: 1 },
          $addToSet: { availableFormats: format },
          $set: { hasReferencePdf: row.hasReferencePdf === true }
        }
      ).exec();
    }

    await this.sourceModel.updateOne(
      { workId: resolvedWorkId, sourceId },
      { $addToSet: { projectIds: projectId } }
    ).exec();

    const linkedSource = await this.sourceModel.findOne({ workId: resolvedWorkId, sourceId }).select('projectIds').lean().exec();
    const projectIds = Array.isArray((linkedSource as any)?.projectIds) ? (linkedSource as any).projectIds : [];
    await this.sourceModel.updateOne(
      { workId: resolvedWorkId, sourceId },
      { $set: { projectLinkCount: projectIds.length } }
    ).exec();

    const updatedRow = await this.rowModel.findOneAndUpdate(
      { projectId, rowId },
      {
        $set: {
          linkedWorkId: resolvedWorkId,
          linkedSourceId: sourceId,
          updatedBy: actor.userId,
          updatedAt: new Date()
        },
        $inc: { rowVersion: 1 }
      },
      { new: true }
    ).lean().exec();

    await this.refreshProjectCounts(projectId);

    return {
      ok: true,
      workId: resolvedWorkId,
      sourceId,
      revisionId: undefined,
      row: updatedRow
    };
  }

  private async resolveWorkIdForRow(
    payload: { workId?: string; imslpUrl?: string },
    row: Pick<ProjectSourceRow, 'imslpUrl'>
  ): Promise<string> {
    return this.resolveWorkId({ workId: payload.workId, imslpUrl: payload.imslpUrl ?? row.imslpUrl });
  }

  private async resolveWorkId(payload: { workId?: string; imslpUrl?: string }): Promise<string> {
    const explicitWorkId = payload.workId?.trim();
    if (explicitWorkId) {
      try {
        await this.worksService.ensureWorkWithMetadata(explicitWorkId);
      } catch {
        // Fallback for legacy/manual records with missing IMSLP metadata.
        await this.worksService.ensureWork(explicitWorkId);
      }
      return explicitWorkId;
    }

    const candidateUrl = payload.imslpUrl?.trim();
    if (!candidateUrl) {
      throw new UnprocessableEntityException('workId or imslpUrl is required');
    }

    const ensured = await this.worksService.saveWorkByImslpUrl(candidateUrl);
    if (!ensured?.work?.workId) {
      throw new UnprocessableEntityException('could not resolve workId from imslpUrl');
    }
    return ensured.work.workId;
  }

  private async canToggleVerified(project: ProjectDocLean, row: any, actor: Actor): Promise<boolean> {
    if (this.isAdmin(actor)) return true;
    if (project.leadUserId === actor.userId) return true;

    if (row?.linkedWorkId && row?.linkedSourceId) {
      const source = await this.sourceModel
        .findOne({ workId: row.linkedWorkId, sourceId: row.linkedSourceId })
        .select('provenance.uploadedByUserId')
        .lean()
        .exec();
      const ownerUserId = (source as any)?.provenance?.uploadedByUserId;
      return ownerUserId && ownerUserId === actor.userId;
    }

    return false;
  }

  private assertCanRead(project: ProjectDocLean, actor?: { userId?: string; roles?: string[] }) {
    if (project.visibility === 'public') return;
    if ((actor?.roles ?? []).includes('admin')) return;
    if (!actor?.userId) {
      throw new ForbiddenException('project is private');
    }
    if (project.leadUserId === actor.userId) return;
    if ((project.memberUserIds ?? []).includes(actor.userId)) return;
    throw new ForbiddenException('project is private');
  }

  private assertCanEditProject(project: ProjectDocLean, actor: Actor) {
    if (this.isAdmin(actor) || project.leadUserId === actor.userId) return;
    throw new ForbiddenException('Only project lead or admin can modify project');
  }

  private assertCanEditRows(project: ProjectDocLean, actor: Actor) {
    if (this.isAdmin(actor)) return;
    if (project.leadUserId === actor.userId) return;
    if ((project.memberUserIds ?? []).includes(actor.userId)) return;
    throw new ForbiddenException('Only project members, lead, or admin can modify rows');
  }

  private assertCanManageProjectSources(project: ProjectDocLean, actor: Actor) {
    if (project.leadUserId === actor.userId) return;
    throw new ForbiddenException('Only project lead can remove sources from project');
  }

  private isAdmin(actor?: { roles?: string[] }) {
    return (actor?.roles ?? []).includes('admin');
  }

  private normalizeUserIds(ids?: string[]) {
    if (!Array.isArray(ids)) return [];
    return Array.from(new Set(ids.map((id) => (id || '').trim()).filter(Boolean)));
  }

  private normalizeUrl(value: string | undefined, field: string): string | undefined {
    const trimmed = (value || '').trim();
    if (!trimmed) return undefined;

    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new BadRequestException(`${field} must be a valid absolute URL`);
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadRequestException(`${field} must use http or https`);
    }

    return parsed.toString();
  }

  private normalizeSpreadsheetProvider(value: string | undefined): 'google' | undefined {
    if (!value) return undefined;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return undefined;
    if (normalized === 'google') {
      return normalized;
    }
    throw new BadRequestException('spreadsheetProvider must be google');
  }

  private safeUrl(value: string): URL | null {
    try {
      return new URL(value);
    } catch {
      return null;
    }
  }

  private defaultSourceLabel(projectTitle: string, rowId: string, externalScoreUrl?: string): string {
    const parsed = externalScoreUrl ? this.safeUrl(externalScoreUrl) : null;
    const fromPath = parsed ? decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '') : '';
    if (fromPath && fromPath !== 'external-link' && fromPath !== '/') {
      return fromPath;
    }
    return `${projectTitle} (${rowId})`;
  }

  private buildSourceDescription(notes?: string, externalScoreUrl?: string, imslpUrl?: string): string | undefined {
    const lines: string[] = [];
    const trimmedNotes = (notes || '').trim();
    if (trimmedNotes) {
      lines.push(trimmedNotes);
    }
    if (externalScoreUrl) {
      lines.push(`External source: ${externalScoreUrl}`);
    }
    if (imslpUrl) {
      lines.push(`IMSLP: ${imslpUrl}`);
    }
    return lines.length > 0 ? lines.join('\n') : undefined;
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private async generateUniqueId(model: Model<any>, field: string, prefix: string): Promise<string> {
    for (let i = 0; i < 10; i += 1) {
      const candidate = `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
      const exists = await model.exists({ [field]: candidate });
      if (!exists) return candidate;
    }
    return `${prefix}_${randomUUID().replace(/-/g, '')}`;
  }

  private slugify(value: string): string {
    const normalized = (value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
    return normalized || 'project';
  }

  private async generateUniqueSlug(value: string): Promise<string> {
    const base = this.slugify(value);
    let slug = base;
    let attempt = 2;
    while (await this.projectModel.exists({ slug })) {
      slug = `${base}-${attempt}`;
      attempt += 1;
      if (slug.length > 96) slug = slug.slice(0, 96);
    }
    return slug;
  }

  private async getProjectDoc(projectId: string): Promise<ProjectDocLean> {
    const project = await this.projectModel.findOne({ projectId }).lean().exec();
    if (!project) throw new NotFoundException('project not found');
    return project as unknown as ProjectDocLean;
  }

  private async assertNoDuplicateRow(
    projectId: string,
    externalScoreUrl?: string,
    imslpUrl?: string,
    excludeRowId?: string
  ): Promise<void> {
    if (!externalScoreUrl && !imslpUrl) return;

    const query: Record<string, unknown> = {
      projectId,
      externalScoreUrl: externalScoreUrl ?? null,
      imslpUrl: imslpUrl ?? null
    };

    // Preserve undefined/null matching by running two checks when needed.
    const candidates: Array<Record<string, unknown>> = [];
    if (externalScoreUrl === undefined) {
      if (imslpUrl === undefined) {
        return;
      }
      candidates.push({ projectId, imslpUrl, $or: [{ externalScoreUrl: { $exists: false } }, { externalScoreUrl: null }] });
    } else if (imslpUrl === undefined) {
      candidates.push({ projectId, externalScoreUrl, $or: [{ imslpUrl: { $exists: false } }, { imslpUrl: null }] });
    } else {
      candidates.push(query);
    }

    for (const candidate of candidates) {
      if (excludeRowId) {
        (candidate as any).rowId = { $ne: excludeRowId };
      }
      const duplicate = await this.rowModel.findOne(candidate).select('rowId').lean().exec();
      if (duplicate) {
        throw new ConflictException('duplicate project row for same source links');
      }
    }
  }

  private async refreshProjectCounts(projectId: string): Promise<void> {
    const [rowCount, linkedSourceCount] = await Promise.all([
      this.rowModel.countDocuments({ projectId }).exec(),
      this.sourceModel.countDocuments({ projectIds: projectId }).exec()
    ]);

    await this.projectModel.updateOne(
      { projectId },
      {
        $set: {
          rowCount,
          linkedSourceCount
        }
      }
    ).exec();
  }

  private async withUserRefs(projects: ProjectDocLean[]) {
    const userIds = new Set<string>();
    for (const project of projects) {
      if (project.leadUserId) userIds.add(project.leadUserId);
      for (const memberId of project.memberUserIds ?? []) {
        if (memberId) userIds.add(memberId);
      }
    }

    const users = userIds.size > 0
      ? await this.userModel
          .find({ _id: { $in: Array.from(userIds) } })
          .select('_id username displayName')
          .lean()
          .exec()
      : [];

    const map = new Map<string, UserRefView>();
    for (const user of users as any[]) {
      map.set(String(user._id), {
        userId: String(user._id),
        username: user.username ?? undefined,
        displayName: user.displayName ?? undefined
      });
    }

    return projects.map((project) => ({
      projectId: project.projectId,
      slug: project.slug,
      title: project.title,
      description: project.description,
      visibility: project.visibility,
      status: project.status,
      rowCount: project.rowCount,
      linkedSourceCount: project.linkedSourceCount,
      spreadsheetProvider: project.spreadsheetProvider,
      spreadsheetEmbedUrl: project.spreadsheetEmbedUrl,
      spreadsheetExternalUrl: project.spreadsheetExternalUrl,
      createdBy: project.createdBy,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      lead: map.get(project.leadUserId) ?? { userId: project.leadUserId },
      members: (project.memberUserIds ?? []).map((id) => map.get(id) ?? { userId: id })
    }));
  }
}
