/*
 * Copyright (C) 2025 OurTextScores Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Work, WorkDocument } from './schemas/work.schema';
import { Source, SourceDocument } from './schemas/source.schema';
import { SourceRevision, SourceRevisionDocument } from './schemas/source-revision.schema';
import { RevisionRating, RevisionRatingDocument } from './schemas/revision-rating.schema';
import { RevisionComment, RevisionCommentDocument } from './schemas/revision-comment.schema';
import { RevisionCommentVote, RevisionCommentVoteDocument } from './schemas/revision-comment-vote.schema';
import { ValidationState } from './schemas/validation.schema';
import { StorageLocator } from './schemas/storage-locator.schema';
import { DerivativeArtifacts } from './schemas/derivatives.schema';
import { ImslpService } from '../imslp/imslp.service';
import { StorageService } from '../storage/storage.service';
import { FossilService } from '../fossil/fossil.service';
import { WatchesService } from '../watches/watches.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SearchService } from '../search/search.service';
import { UsersService } from '../users/users.service';
import { ImslpWorkDto } from '../imslp/dto/imslp-work.dto';

export interface WorkSummary {
  workId: string;
  latestRevisionAt?: Date;
  sourceCount: number;
  availableFormats: string[];
  hasReferencePdf?: boolean;
  hasVerifiedSources?: boolean;
  hasFlaggedSources?: boolean;
  title?: string;
  composer?: string;
  catalogNumber?: string;
}

export interface PaginatedWorksResponse {
  works: WorkSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface SourceRevisionView {
  revisionId: string;
  sequenceNumber: number;
  createdAt: Date;
  createdBy: string;
  createdByUsername?: string;
  changeSummary?: string;
  rawStorage: StorageLocator;
  checksum: { algorithm: string; hexDigest: string };
  derivatives?: DerivativeArtifacts;
  manifest?: StorageLocator;
  validation: ValidationState;
  fossilArtifactId?: string;
  fossilParentArtifactIds: string[];
  fossilBranch?: string;
  license?: string;
  licenseUrl?: string;
  licenseAttribution?: string;
}

export interface SourceView {
  sourceId: string;
  label: string;
  sourceType: Source['sourceType'];
  format: string;
  description?: string;
  originalFilename: string;
  isPrimary: boolean;
  hasReferencePdf?: boolean;
  adminVerified?: boolean;
  adminVerifiedBy?: string;
  adminVerifiedAt?: Date;
  adminVerificationNote?: string;
  adminFlagged?: boolean;
  adminFlaggedBy?: string;
  adminFlaggedAt?: Date;
  adminFlagReason?: string;
  storage: StorageLocator;
  validation: ValidationState;
  provenance: Source['provenance'];
  derivatives?: DerivativeArtifacts;
  latestRevisionId?: string;
  latestRevisionAt?: Date;
  revisions: SourceRevisionView[];
}

export interface WorkDetail extends WorkSummary {
  sources: SourceView[];
}

export interface ViewerContext {
  userId?: string;
  roles?: string[];
}

export interface EnsureWorkResponse {
  work: WorkSummary;
  metadata: ImslpWorkDto;
}

@Injectable()
export class WorksService {
  private readonly execFileAsync = promisify(execFile);
  constructor(
    @InjectModel(Work.name)
    private readonly workModel: Model<WorkDocument>,
    @InjectModel(Source.name)
    private readonly sourceModel: Model<SourceDocument>,
    @InjectModel(SourceRevision.name)
    private readonly sourceRevisionModel: Model<SourceRevisionDocument>,
    @InjectModel(RevisionRating.name)
    private readonly revisionRatingModel: Model<RevisionRatingDocument>,
    @InjectModel(RevisionComment.name)
    private readonly revisionCommentModel: Model<RevisionCommentDocument>,
    @InjectModel(RevisionCommentVote.name)
    private readonly revisionCommentVoteModel: Model<RevisionCommentVoteDocument>,
    private readonly imslpService: ImslpService,
    private readonly storageService: StorageService,
    private readonly fossilService: FossilService,
    private readonly watches: WatchesService,
    private readonly notifications: NotificationsService,
    private readonly searchService: SearchService,
    private readonly usersService: UsersService
  ) { }

  async findAll(options?: { limit?: number; offset?: number; filter?: string }): Promise<PaginatedWorksResponse> {
    const limit = options?.limit ?? 20;
    const offset = options?.offset ?? 0;
    const filter = options?.filter;

    // If a filter is provided, use the search service (MeiliSearch)
    if (filter) {
      const searchResult = await this.searchService.searchWorks('', {
        limit,
        offset,
        filter
      });

      const summaries: WorkSummary[] = searchResult.hits.map((hit: any) => ({
        workId: hit.workId,
        latestRevisionAt: hit.latestRevisionAt ? new Date(hit.latestRevisionAt) : undefined,
        sourceCount: hit.sourceCount ?? 0,
        availableFormats: hit.availableFormats ?? [],
        hasReferencePdf: hit.hasReferencePdf,
        hasVerifiedSources: hit.hasVerifiedSources,
        hasFlaggedSources: hit.hasFlaggedSources,
        title: hit.title ?? undefined,
        composer: hit.composer ?? undefined,
        catalogNumber: hit.catalogNumber ?? undefined
      }));

      return {
        works: summaries,
        total: searchResult.estimatedTotalHits,
        limit,
        offset
      };
    }

    // Otherwise use MongoDB directly (no search/filter)
    // Get total count
    const total = await this.workModel.countDocuments().exec();

    // Get paginated documents
    const documents = await this.workModel
      .find()
      .sort({ latestRevisionAt: -1, workId: 1 })
      .skip(offset)
      .limit(limit)
      .lean()
      .exec();

    const summaries: WorkSummary[] = documents.map((doc: any) => ({
      workId: doc.workId,
      latestRevisionAt: doc.latestRevisionAt ?? undefined,
      sourceCount: doc.sourceCount,
      availableFormats: doc.availableFormats ?? [],
      hasReferencePdf: doc.hasReferencePdf,
      hasVerifiedSources: doc.hasVerifiedSources,
      hasFlaggedSources: doc.hasFlaggedSources,
      title: doc.title ?? undefined,
      composer: doc.composer ?? undefined,
      catalogNumber: doc.catalogNumber ?? undefined
    }));

    // Enrich with IMSLP title/composer if available (local DB lookup via service)
    await Promise.all(
      summaries.map(async (s) => {
        try {
          const ensured = await this.imslpService.ensureByWorkId(s.workId);
          if (!s.title) s.title = ensured.metadata.title;
          if (!s.composer) s.composer = ensured.metadata.composer;
        } catch {
          // ignore if metadata not available
        }
      })
    );

    return {
      works: summaries,
      total,
      limit,
      offset
    };
  }

  async ensureWork(workId: string): Promise<WorkDocument> {
    if (!/^\d+$/.test(workId)) {
      throw new BadRequestException('workId must be the numeric IMSLP page_id');
    }
    return this.workModel
      .findOneAndUpdate(
        { workId },
        {
          $setOnInsert: {
            workId,
            sourceCount: 0,
            availableFormats: []
          }
        },
        { new: true, upsert: true }
      )
      .exec();
  }

  async ensureWorkWithMetadata(workId: string): Promise<EnsureWorkResponse> {
    if (!/^\d+$/.test(workId)) {
      throw new BadRequestException('workId must be the numeric IMSLP page_id');
    }
    const metadataResult = await this.imslpService.ensureByWorkId(workId);
    const workDocument = await this.ensureWork(workId);

    return {
      work: this.toSummary(workDocument),
      metadata: metadataResult.metadata
    };
  }

  async saveWorkByImslpUrl(url: string): Promise<EnsureWorkResponse> {
    // Resolve numeric page id from URL. Try strict resolver first, then service-based.
    let pageId = await this.resolvePageIdStrict(url).catch(() => null);
    if (!pageId) {
      pageId = await this.resolvePageIdViaNode(url).catch(() => null);
    }
    if (!pageId) {
      pageId = await this.imslpService.resolvePageIdFromUrl(url).catch(() => null);
    }

    if (!pageId || !/^\d+$/.test(String(pageId))) {
      throw new BadRequestException('Unable to resolve numeric IMSLP page_id from URL');
    }

    const finalWorkId = String(pageId);

    // Attempt enrichment via permalink (more reliable for initial scrape), must produce basic_info and files
    const ensured = await this.imslpService.ensureByPermalink(url);
    const ensuredMeta = ensured?.metadata?.metadata ?? {} as Record<string, unknown>;
    const basic = (ensuredMeta['basic_info'] as Record<string, unknown> | undefined) ?? undefined;
    const hasNumericBasic = basic != null && /^\d+$/.test(String((basic as any)['page_id']));
    const hasFiles = Array.isArray((ensuredMeta as any)['files']) && ((ensuredMeta as any)['files'] as any[]).length > 0;

    if (!hasNumericBasic || !hasFiles) {
      throw new BadRequestException('Unable to obtain enriched IMSLP metadata; record not created');
    }

    // Create Work only after successful enrichment
    const workDoc = await this.ensureWork(finalWorkId);
    const metadataResult = await this.imslpService.ensureByWorkId(finalWorkId);

    return {
      work: this.toSummary(workDoc),
      metadata: metadataResult.metadata
    };
  }

  private async resolvePageIdStrict(permalinkOrSlug: string): Promise<string | null> {
    const script = `
import sys, re
from urllib.parse import unquote, quote
import requests

target = sys.argv[1]
slug = target
if target.startswith('http://') or target.startswith('https://'):
    if '/wiki/' in target:
        slug = target.split('/wiki/', 1)[1]
    else:
        slug = target
slug = unquote(slug)
url = 'https://imslp.org/wiki/' + quote(slug)
try:
    r = requests.get(url, timeout=15)
    if not r.ok:
        sys.exit(1)
    m = re.search(r'"wgArticleId"\s*:\s*(\d+)', r.text)
    if not m:
        sys.exit(1)
    print(m.group(1))
except Exception:
    sys.exit(1)
`;

    try {
      const { stdout } = await this.execFileAsync('python3', ['-c', script, permalinkOrSlug], {
        maxBuffer: 256 * 1024,
        timeout: 20_000
      });
      const pageId = stdout.trim();
      if (!pageId) return null;
      return pageId;
    } catch {
      return null;
    }
  }

  async recordSourceUpload(
    workId: string,
    formats: string[],
    timestamp: Date
  ): Promise<WorkDocument | null> {
    const update: Record<string, unknown> = {
      $inc: { sourceCount: 1 },
      $set: { latestRevisionAt: timestamp }
    };

    const uniqueFormats = formats.filter(
      (value): value is string => typeof value === 'string' && value.length > 0
    );
    if (uniqueFormats.length > 0) {
      update.$addToSet = { availableFormats: { $each: uniqueFormats } };
    }

    return this.workModel
      .findOneAndUpdate({ workId }, update, { new: true })
      .exec();
  }

  async recordSourceRevision(
    workId: string,
    formats: string[],
    timestamp: Date
  ): Promise<WorkDocument | null> {
    const update: Record<string, unknown> = {
      $set: { latestRevisionAt: timestamp }
    };
    const uniqueFormats = formats.filter(
      (value): value is string => typeof value === 'string' && value.length > 0
    );
    if (uniqueFormats.length > 0) {
      (update as any).$addToSet = { availableFormats: { $each: uniqueFormats } };
    }
    const updated = await this.workModel
      .findOneAndUpdate({ workId }, update, { new: true })
      .exec();

    // Index in search after update
    if (updated) {
      const summary = this.toSummary(updated);
      await this.indexWork(summary);
    }

    return updated;
  }

  async getWorkDetail(workId: string, viewer?: ViewerContext): Promise<WorkDetail> {
    const work = await this.workModel.findOne({ workId }).lean().exec();
    if (!work) {
      throw new NotFoundException(`Work ${workId} not found`);
    }

    const sources = await this.sourceModel
      .find({ workId })
      .sort({ latestRevisionAt: -1, label: 1 })
      .lean()
      .exec();

    const sourceIds = sources.map((source) => source.sourceId);
    const revisions = await this.sourceRevisionModel
      .find({ workId, sourceId: { $in: sourceIds } })
      .sort({ sourceId: 1, sequenceNumber: -1 })
      .lean()
      .exec();

    // Collect unique user IDs and fetch usernames
    const uniqueUserIds = new Set<string>();
    for (const revision of revisions) {
      if (revision.createdBy && revision.createdBy !== 'system') {
        uniqueUserIds.add(revision.createdBy);
      }
    }

    // Fetch users and create userId -> username map
    const userIdToUsername = new Map<string, string>();
    if (uniqueUserIds.size > 0) {
      const users = await this.usersService['userModel']
        .find({ _id: { $in: Array.from(uniqueUserIds) } })
        .select('_id username')
        .lean()
        .exec();
      for (const user of users) {
        if (user.username) {
          userIdToUsername.set(String(user._id), user.username);
        }
      }
    }

    const revisionsBySource = new Map<string, SourceRevisionView[]>();
    for (const source of sources) {
      revisionsBySource.set(source.sourceId, []);
    }

    for (const revision of revisions) {
      // Enforce visibility: approved always visible; pending/rejected only to owner/uploader/admin
      const canSee = (() => {
        const status = (revision as any).status || 'approved';
        if (status === 'approved') return true;
        const roles = viewer?.roles ?? [];
        if (roles.includes('admin')) return true;
        const isUploader = viewer?.userId && viewer.userId === String((revision as any).createdBy);
        if (isUploader) return true;
        const ownerUserId = (revision as any).approval?.ownerUserId as string | undefined;
        if (ownerUserId && viewer?.userId === ownerUserId) return true;
        return false;
      })();
      if (!canSee) continue;

      const list = revisionsBySource.get(revision.sourceId) ?? [];
      // Derive a safer validation view: if derivatives exist but snapshot is still 'pending', treat as passed in the view
      const vSnap: ValidationState = (revision as any).validationSnapshot || { status: 'pending', issues: [] };
      const hasDerivatives = !!((revision as any).derivatives?.linearizedXml || (revision as any).derivatives?.canonicalXml);
      const validationForView: ValidationState = (vSnap.status === 'pending' && hasDerivatives)
        ? { ...vSnap, status: 'passed', performedAt: vSnap.performedAt || (revision as any).createdAt }
        : vSnap;
      list.push({
        revisionId: revision.revisionId,
        sequenceNumber: revision.sequenceNumber,
        createdAt: revision.createdAt,
        createdBy: revision.createdBy,
        createdByUsername: userIdToUsername.get(revision.createdBy),
        changeSummary: revision.changeSummary,
        rawStorage: revision.rawStorage,
        checksum: revision.checksum,
        derivatives: revision.derivatives,
        manifest: revision.manifest,
        validation: validationForView,
        fossilArtifactId: revision.fossilArtifactId,
        fossilParentArtifactIds: revision.fossilParentArtifactIds ?? [],
        fossilBranch: (revision as any).fossilBranch ?? undefined,
        license: (revision as any).license,
        licenseUrl: (revision as any).licenseUrl,
        licenseAttribution: (revision as any).licenseAttribution
      });
      revisionsBySource.set(revision.sourceId, list);
    }

    const sourceViews: SourceView[] = sources.map((source) => ({
      sourceId: source.sourceId,
      label: source.label,
      sourceType: source.sourceType,
      format: source.format,
      description: source.description,
      originalFilename: source.originalFilename,
      isPrimary: source.isPrimary,
      hasReferencePdf: source.hasReferencePdf,
      adminVerified: (source as any).adminVerified,
      adminVerifiedBy: (source as any).adminVerifiedBy,
      adminVerifiedAt: (source as any).adminVerifiedAt,
      adminVerificationNote: (source as any).adminVerificationNote,
      adminFlagged: (source as any).adminFlagged,
      adminFlaggedBy: (source as any).adminFlaggedBy,
      adminFlaggedAt: (source as any).adminFlaggedAt,
      adminFlagReason: (source as any).adminFlagReason,
      storage: source.storage,
      validation: source.validation,
      provenance: source.provenance,
      derivatives: source.derivatives,
      latestRevisionId: source.latestRevisionId,
      latestRevisionAt: source.latestRevisionAt ?? undefined,
      revisions: revisionsBySource.get(source.sourceId) ?? []
    }));

    const summary = this.toSummary(work);

    return {
      ...summary,
      sources: sourceViews
    };
  }

  async prunePendingSources(workId: string): Promise<{ removed: number }> {
    // Define "pending" sources as those lacking a linearized derivative
    const pendingSources = await this.sourceModel
      .find({
        workId, $or: [
          { derivatives: { $exists: false } },
          { 'derivatives.linearizedXml': { $exists: false } }
        ]
      })
      .lean()
      .exec();

    let removed = 0;
    for (const src of pendingSources) {
      const revisions = await this.sourceRevisionModel
        .find({ workId, sourceId: src.sourceId })
        .lean()
        .exec();

      // Collect all storage locators to delete
      const toDelete: { bucket: string; objectKey: string }[] = [];
      const add = (loc?: StorageLocator) => {
        if (loc) toDelete.push({ bucket: loc.bucket, objectKey: loc.objectKey });
      };
      add(src.storage);
      add(src.derivatives?.normalizedMxl);
      add(src.derivatives?.canonicalXml);
      add(src.derivatives?.linearizedXml);
      add(src.derivatives?.manifest);
      for (const rev of revisions) {
        add(rev.rawStorage);
        add(rev.derivatives?.normalizedMxl);
        add(rev.derivatives?.canonicalXml);
        add(rev.derivatives?.linearizedXml);
        add(rev.derivatives?.musicDiffReport);
        add(rev.manifest);
      }

      // Delete objects (best-effort)
      for (const obj of toDelete) {
        await this.storageService.deleteObject(obj.bucket, obj.objectKey).catch(() => { });
      }

      // Remove fossil repository if created
      await this.fossilService.removeRepository(workId, src.sourceId).catch(() => { });

      // Remove DB docs
      await this.sourceRevisionModel.deleteMany({ workId, sourceId: src.sourceId }).exec();
      await this.sourceModel.deleteOne({ workId, sourceId: src.sourceId }).exec();
      removed += 1;
    }

    // Recompute work summary fields
    await this.recomputeWorkStats(workId);
    return { removed };
  }

  private async recomputeWorkStats(workId: string): Promise<void> {
    const remaining = await this.sourceModel.find({ workId }).lean().exec();
    const sourceCount = remaining.length;
    const formats = new Set<string>();
    let hasReferencePdf = false;
    let hasVerifiedSources = false;
    let hasFlaggedSources = false;
    for (const s of remaining) {
      if (s.format) formats.add(s.format);
      const d: any = s.derivatives ?? {};
      if (d.normalizedMxl) formats.add('application/vnd.recordare.musicxml');
      if (d.canonicalXml) formats.add('application/xml');
      if (d.linearizedXml) formats.add('text/plain');
      if (s.hasReferencePdf) hasReferencePdf = true;
      if ((s as any).adminVerified) hasVerifiedSources = true;
      if ((s as any).adminFlagged) hasFlaggedSources = true;
    }
    const updated = await this.workModel
      .findOneAndUpdate(
        { workId },
        { $set: { sourceCount, availableFormats: Array.from(formats), hasReferencePdf, hasVerifiedSources, hasFlaggedSources } },
        { new: true }
      )
      .exec();

    // Index in search after stats update
    if (updated) {
      const summary = this.toSummary(updated);
      await this.indexWork(summary);
    }
  }

  async deleteAllSources(workId: string): Promise<{ removed: number }> {
    const allSources = await this.sourceModel.find({ workId }).lean().exec();
    let removed = 0;

    for (const src of allSources) {
      const revisions = await this.sourceRevisionModel
        .find({ workId, sourceId: src.sourceId })
        .lean()
        .exec();

      const toDelete: { bucket: string; objectKey: string }[] = [];
      const add = (loc?: StorageLocator) => {
        if (loc) toDelete.push({ bucket: loc.bucket, objectKey: loc.objectKey });
      };
      add(src.storage);
      add(src.derivatives?.normalizedMxl);
      add(src.derivatives?.canonicalXml);
      add(src.derivatives?.linearizedXml);
      add(src.derivatives?.manifest);
      for (const rev of revisions) {
        add(rev.rawStorage);
        add(rev.derivatives?.normalizedMxl);
        add(rev.derivatives?.canonicalXml);
        add(rev.derivatives?.linearizedXml);
        add(rev.derivatives?.musicDiffReport);
        add(rev.manifest);
      }

      for (const obj of toDelete) {
        await this.storageService.deleteObject(obj.bucket, obj.objectKey).catch(() => { });
      }

      await this.fossilService.removeRepository(workId, src.sourceId).catch(() => { });

      await this.sourceRevisionModel.deleteMany({ workId, sourceId: src.sourceId }).exec();
      await this.sourceModel.deleteOne({ workId, sourceId: src.sourceId }).exec();
      removed += 1;
    }

    await this.workModel
      .findOneAndUpdate(
        { workId },
        { $set: { sourceCount: 0, availableFormats: [], latestRevisionAt: undefined } },
        { new: false }
      )
      .exec();

    return { removed };
  }

  async deleteSource(
    workId: string,
    sourceId: string,
    actor: { userId: string; roles?: string[] }
  ): Promise<{ removed: boolean }> {
    const src = await this.sourceModel.findOne({ workId, sourceId }).lean().exec();
    if (!src) return { removed: false };

    const isAdmin = (actor.roles ?? []).includes('admin');
    const revisions = await this.sourceRevisionModel
      .find({ workId, sourceId })
      .lean()
      .exec();

    if (!isAdmin) {
      const distinctCreators = Array.from(
        new Set(
          revisions
            .map((rev) => rev.createdBy)
            .filter((id): id is string => !!id && id !== 'system')
        )
      );

      if (distinctCreators.length === 0) {
        // Fallback to original provenance owner
        const ownerUserId = (src as any).provenance?.uploadedByUserId as string | undefined;
        if (!ownerUserId || actor.userId !== ownerUserId) {
          throw new ForbiddenException('Only source owner or admin can delete source');
        }
      } else if (distinctCreators.length === 1) {
        const soleOwnerId = distinctCreators[0];
        if (actor.userId !== soleOwnerId) {
          throw new ForbiddenException('Only source owner or admin can delete source');
        }
      } else {
        throw new ForbiddenException('Only admin can delete a source with revisions from multiple users');
      }
    }

    const toDelete: { bucket: string; objectKey: string }[] = [];
    const add = (loc?: StorageLocator) => { if (loc) toDelete.push({ bucket: loc.bucket, objectKey: loc.objectKey }); };
    add(src.storage);
    add(src.derivatives?.normalizedMxl);
    add(src.derivatives?.canonicalXml);
    add(src.derivatives?.linearizedXml);
    add(src.derivatives?.manifest);
    for (const rev of revisions) {
      add(rev.rawStorage);
      add(rev.derivatives?.normalizedMxl);
      add(rev.derivatives?.canonicalXml);
      add(rev.derivatives?.linearizedXml);
      add(rev.derivatives?.musicDiffReport);
      add((rev as any).derivatives?.musicDiffHtml);
      add((rev as any).derivatives?.musicDiffPdf);
      add(rev.manifest);
    }
    for (const obj of toDelete) {
      await this.storageService.deleteObject(obj.bucket, obj.objectKey).catch(() => { });
    }
    await this.fossilService.removeRepository(workId, sourceId).catch(() => { });
    await this.sourceRevisionModel.deleteMany({ workId, sourceId }).exec();
    await this.sourceModel.deleteOne({ workId, sourceId }).exec();
    await this.recomputeWorkStats(workId);
    return { removed: true };
  }

  private toSummary(
    work: Pick<Work, 'workId' | 'latestRevisionAt' | 'sourceCount' | 'availableFormats'> & Partial<Work>
  ): WorkSummary {
    return {
      workId: work.workId,
      latestRevisionAt: work.latestRevisionAt ?? undefined,
      sourceCount: work.sourceCount,
      availableFormats: work.availableFormats ?? [],
      hasReferencePdf: (work as any).hasReferencePdf,
      hasVerifiedSources: (work as any).hasVerifiedSources,
      hasFlaggedSources: (work as any).hasFlaggedSources,
      title: (work as any).title ?? undefined,
      composer: (work as any).composer ?? undefined,
      catalogNumber: (work as any).catalogNumber ?? undefined
    };
  }

  /**
   * Index a work in the search service
   */
  private async indexWork(summary: WorkSummary): Promise<void> {
    await this.searchService.indexWork({
      id: summary.workId,
      workId: summary.workId,
      title: summary.title,
      composer: summary.composer,
      catalogNumber: summary.catalogNumber,
      sourceCount: summary.sourceCount,
      availableFormats: summary.availableFormats,
      hasReferencePdf: summary.hasReferencePdf,
      hasVerifiedSources: summary.hasVerifiedSources,
      hasFlaggedSources: summary.hasFlaggedSources,
      latestRevisionAt: summary.latestRevisionAt?.getTime()
    });
  }

  async approveRevision(
    workId: string,
    sourceId: string,
    revisionId: string,
    actor: { userId: string; roles?: string[] }
  ): Promise<{ status: 'approved' } | never> {
    const rev = await this.sourceRevisionModel.findOne({ workId, sourceId, revisionId }).exec();
    if (!rev) throw new NotFoundException('Revision not found');
    if (rev.status === 'approved') return { status: 'approved' };

    const ownerUserId = rev.approval?.ownerUserId;
    const isAdmin = (actor.roles ?? []).includes('admin');
    if (!isAdmin && (!ownerUserId || ownerUserId !== actor.userId)) {
      throw new BadRequestException('Only branch owner or admin can approve');
    }

    rev.status = 'approved';
    rev.approval = {
      ...(rev.approval ?? {}),
      decidedAt: new Date(),
      decidedByUserId: actor.userId,
      decision: 'approved'
    };
    await rev.save();

    // Update source latest pointers
    const receivedAt = rev.createdAt || new Date();
    await this.sourceModel.updateOne(
      { workId, sourceId },
      {
        $set: {
          latestRevisionId: rev.revisionId,
          latestRevisionAt: receivedAt,
          derivatives: rev.derivatives
        }
      }
    ).exec();
    // Update work summary
    const formatsForWork = new Set<string>();
    if (rev.derivatives?.normalizedMxl) formatsForWork.add('application/vnd.recordare.musicxml');
    if (rev.derivatives?.linearizedXml) formatsForWork.add('text/plain');
    if (rev.derivatives?.canonicalXml) formatsForWork.add('application/xml');
    await this.recordSourceRevision(workId, Array.from(formatsForWork), receivedAt);

    // Notify watchers
    const userIds = await this.watches.getSubscribersUserIds(workId, sourceId);
    if (userIds.length > 0) {
      await this.notifications.queueNewRevision({ workId, sourceId, revisionId: rev.revisionId, userIds });
    }

    return { status: 'approved' };
  }

  async rejectRevision(
    workId: string,
    sourceId: string,
    revisionId: string,
    actor: { userId: string; roles?: string[] }
  ): Promise<{ status: 'rejected' } | never> {
    const rev = await this.sourceRevisionModel.findOne({ workId, sourceId, revisionId }).exec();
    if (!rev) throw new NotFoundException('Revision not found');
    if (rev.status === 'rejected') return { status: 'rejected' };

    const ownerUserId = rev.approval?.ownerUserId;
    const isAdmin = (actor.roles ?? []).includes('admin');
    if (!isAdmin && (!ownerUserId || ownerUserId !== actor.userId)) {
      throw new BadRequestException('Only branch owner or admin can reject');
    }

    rev.status = 'rejected';
    rev.approval = {
      ...(rev.approval ?? {}),
      decidedAt: new Date(),
      decidedByUserId: actor.userId,
      decision: 'rejected'
    };
    await rev.save();
    return { status: 'rejected' };
  }

  // Attach or update musicdiff derivative locators for a specific revision.
  // Also mirrors onto Source.derivatives if this revision is the latest.
  async upsertMusicDiffDerivatives(
    workId: string,
    sourceId: string,
    revisionId: string,
    updates: {
      musicDiffHtml?: StorageLocator;
      musicDiffPdf?: StorageLocator;
      musicDiffReport?: StorageLocator;
    }
  ): Promise<void> {
    const setPayload: Record<string, unknown> = {};
    if (updates.musicDiffHtml) setPayload['derivatives.musicDiffHtml'] = updates.musicDiffHtml;
    if (updates.musicDiffPdf) setPayload['derivatives.musicDiffPdf'] = updates.musicDiffPdf;
    if (updates.musicDiffReport) setPayload['derivatives.musicDiffReport'] = updates.musicDiffReport;
    if (Object.keys(setPayload).length > 0) {
      await this.sourceRevisionModel.updateOne({ workId, sourceId, revisionId }, { $set: setPayload }).exec();
      // If this revision is the latest for the source, also mirror onto Source.
      await this.sourceModel.updateOne(
        { workId, sourceId, latestRevisionId: revisionId },
        { $set: setPayload }
      ).exec();
    }
  }

  async updateWorkMetadata(
    workId: string,
    updates: { title?: string; composer?: string; catalogNumber?: string }
  ): Promise<WorkSummary> {
    const payload: Record<string, unknown> = {};
    if (updates.title !== undefined) payload['title'] = updates.title?.trim() || undefined;
    if (updates.composer !== undefined) payload['composer'] = updates.composer?.trim() || undefined;
    if (updates.catalogNumber !== undefined)
      payload['catalogNumber'] = updates.catalogNumber?.trim() || undefined;

    const updated = await this.workModel
      .findOneAndUpdate(
        { workId },
        { $set: payload },
        { new: true, upsert: false }
      )
      .lean()
      .exec();

    if (!updated) {
      throw new NotFoundException(`Work ${workId} not found`);
    }

    const summary = this.toSummary(updated as any);
    // Index in search
    await this.indexWork(summary);
    return summary;
  }

  async updateSource(
    workId: string,
    sourceId: string,
    updates: { label?: string; description?: string }
  ): Promise<{ ok: boolean }> {
    const payload: Record<string, unknown> = {};
    if (updates.label !== undefined) payload['label'] = updates.label?.trim() || undefined;
    if (updates.description !== undefined) payload['description'] = updates.description?.trim() || undefined;

    const updated = await this.sourceModel
      .findOneAndUpdate(
        { workId, sourceId },
        { $set: payload },
        { new: true }
      )
      .lean()
      .exec();

    if (!updated) {
      throw new NotFoundException(`Source ${sourceId} not found in work ${workId}`);
    }

    return { ok: true };
  }

  async verifySource(
    workId: string,
    sourceId: string,
    userId: string,
    note?: string
  ): Promise<{ ok: true; verifiedAt: Date }> {
    const now = new Date();
    const updated = await this.sourceModel
      .findOneAndUpdate(
        { workId, sourceId },
        {
          $set: {
            adminVerified: true,
            adminVerifiedBy: userId,
            adminVerifiedAt: now,
            adminVerificationNote: note?.trim() || undefined
          }
        },
        { new: true }
      )
      .exec();

    if (!updated) {
      throw new NotFoundException(`Source ${sourceId} not found in work ${workId}`);
    }

    // Recompute work stats to update hasVerifiedSources aggregation
    await this.recomputeWorkStats(workId);

    return { ok: true, verifiedAt: now };
  }

  async removeVerification(
    workId: string,
    sourceId: string
  ): Promise<{ ok: true }> {
    const updated = await this.sourceModel
      .findOneAndUpdate(
        { workId, sourceId },
        {
          $set: {
            adminVerified: false
          },
          $unset: {
            adminVerifiedBy: '',
            adminVerifiedAt: '',
            adminVerificationNote: ''
          }
        },
        { new: true }
      )
      .exec();

    if (!updated) {
      throw new NotFoundException(`Source ${sourceId} not found in work ${workId}`);
    }

    // Recompute work stats to update hasVerifiedSources aggregation
    await this.recomputeWorkStats(workId);

    return { ok: true };
  }

  async flagSource(
    workId: string,
    sourceId: string,
    userId: string,
    reason: string
  ): Promise<{ ok: true; flaggedAt: Date }> {
    if (!reason || !reason.trim()) {
      throw new BadRequestException('Flag reason is required');
    }

    const now = new Date();
    const updated = await this.sourceModel
      .findOneAndUpdate(
        { workId, sourceId },
        {
          $set: {
            adminFlagged: true,
            adminFlaggedBy: userId,
            adminFlaggedAt: now,
            adminFlagReason: reason.trim()
          }
        },
        { new: true }
      )
      .exec();

    if (!updated) {
      throw new NotFoundException(`Source ${sourceId} not found in work ${workId}`);
    }

    // Recompute work stats to update hasFlaggedSources aggregation
    await this.recomputeWorkStats(workId);

    return { ok: true, flaggedAt: now };
  }

  async removeFlag(
    workId: string,
    sourceId: string
  ): Promise<{ ok: true }> {
    const updated = await this.sourceModel
      .findOneAndUpdate(
        { workId, sourceId },
        {
          $set: {
            adminFlagged: false
          },
          $unset: {
            adminFlaggedBy: '',
            adminFlaggedAt: '',
            adminFlagReason: ''
          }
        },
        { new: true }
      )
      .exec();

    if (!updated) {
      throw new NotFoundException(`Source ${sourceId} not found in work ${workId}`);
    }

    // Recompute work stats to update hasFlaggedSources aggregation
    await this.recomputeWorkStats(workId);

    return { ok: true };
  }

  private async resolvePageIdViaNode(permalinkOrSlug: string): Promise<string | null> {
    const buildUrl = (target: string): string => {
      let slug = target;
      if (target.startsWith('http://') || target.startsWith('https://')) {
        const idx = target.indexOf('/wiki/');
        slug = idx >= 0 ? target.substring(idx + 6) : target;
      }
      try {
        slug = decodeURIComponent(slug);
      } catch {
        // ignore
      }
      const encoded = encodeURIComponent(slug).replace(/%20/g, '_');
      return `https://imslp.org/wiki/${encoded}`;
    };

    const url = buildUrl(permalinkOrSlug);
    const html = await new Promise<string>((resolve, reject) => {
      const https = require('node:https');
      const req = https.get(url, (res: any) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // simple redirect follow
          const redirected = buildUrl(res.headers.location as string);
          https.get(redirected, (res2: any) => {
            let data = '';
            res2.setEncoding('utf8');
            res2.on('data', (chunk: string) => (data += chunk));
            res2.on('end', () => resolve(data));
            res2.on('error', reject);
          }).on('error', reject);
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => resolve(data));
      });
      req.setTimeout(15000, () => {
        req.destroy(new Error('timeout'));
      });
      req.on('error', reject);
    });

    const m = /"wgArticleId"\s*:\s*(\d+)/.exec(html);
    return m ? m[1] : null;
  }

  /**
   * Rate a revision (1-5 stars). One rating per user per revision.
   */
  async rateRevision(
    workId: string,
    sourceId: string,
    revisionId: string,
    userId: string,
    rating: number,
    isAdmin: boolean
  ): Promise<{ ok: true; ratedAt: Date }> {
    if (rating < 1 || rating > 5) {
      throw new BadRequestException('Rating must be between 1 and 5');
    }

    // Verify revision exists
    const revision = await this.sourceRevisionModel
      .findOne({ workId, sourceId, revisionId })
      .exec();

    if (!revision) {
      throw new NotFoundException(`Revision ${revisionId} not found`);
    }

    // Check if user already rated
    const existing = await this.revisionRatingModel
      .findOne({ revisionId, userId })
      .exec();

    if (existing) {
      throw new BadRequestException('You have already rated this revision');
    }

    const now = new Date();
    await this.revisionRatingModel.create({
      workId,
      sourceId,
      revisionId,
      userId,
      rating,
      isAdmin,
      ratedAt: now
    });

    return { ok: true, ratedAt: now };
  }

  /**
   * Get rating histogram for a revision
   * Returns counts per star level (1-5), split by user vs admin
   */
  async getRevisionRatings(
    workId: string,
    sourceId: string,
    revisionId: string
  ): Promise<{
    histogram: Array<{ stars: number; userCount: number; adminCount: number }>;
    totalRatings: number;
  }> {
    // Verify revision exists
    const revision = await this.sourceRevisionModel
      .findOne({ workId, sourceId, revisionId })
      .exec();

    if (!revision) {
      throw new NotFoundException(`Revision ${revisionId} not found`);
    }

    // Aggregate ratings by star level and admin status
    const aggregation = await this.revisionRatingModel.aggregate([
      { $match: { revisionId } },
      {
        $group: {
          _id: { rating: '$rating', isAdmin: '$isAdmin' },
          count: { $sum: 1 }
        }
      }
    ]);

    // Build histogram with all star levels (1-5)
    const histogram = [1, 2, 3, 4, 5].map(stars => {
      const userEntry = aggregation.find(a => a._id.rating === stars && !a._id.isAdmin);
      const adminEntry = aggregation.find(a => a._id.rating === stars && a._id.isAdmin);
      return {
        stars,
        userCount: userEntry?.count ?? 0,
        adminCount: adminEntry?.count ?? 0
      };
    });

    const totalRatings = aggregation.reduce((sum, a) => sum + a.count, 0);

    return { histogram, totalRatings };
  }

  /**
   * Check if a user has rated a specific revision
   */
  async hasUserRatedRevision(
    revisionId: string,
    userId: string
  ): Promise<boolean> {
    const existing = await this.revisionRatingModel
      .findOne({ revisionId, userId })
      .exec();

    return !!existing;
  }

  /**
   * Create a comment on a revision
   */
  async createComment(
    workId: string,
    sourceId: string,
    revisionId: string,
    userId: string,
    content: string,
    parentCommentId?: string
  ): Promise<{ commentId: string; createdAt: Date }> {
    if (!content || !content.trim()) {
      throw new BadRequestException('Comment content is required');
    }

    // Verify revision exists
    const revision = await this.sourceRevisionModel
      .findOne({ workId, sourceId, revisionId })
      .exec();

    if (!revision) {
      throw new NotFoundException(`Revision ${revisionId} not found`);
    }

    // If replying to a comment, verify parent exists
    if (parentCommentId) {
      const parent = await this.revisionCommentModel
        .findOne({ commentId: parentCommentId })
        .exec();

      if (!parent || parent.deleted) {
        throw new NotFoundException('Parent comment not found');
      }
    }

    const commentId = `cmt-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const now = new Date();

    await this.revisionCommentModel.create({
      commentId,
      workId,
      sourceId,
      revisionId,
      userId,
      content: content.trim(),
      parentCommentId,
      voteScore: 0,
      createdAt: now
    });

    // Send notifications
    if (parentCommentId) {
      // Reply notification
      const parent = await this.revisionCommentModel.findOne({ commentId: parentCommentId }).exec();
      if (parent && parent.userId !== userId) {
        await this.notifications.queueCommentReply({
          workId,
          sourceId,
          revisionId,
          commentId,
          recipientUserId: parent.userId,
          actorUserId: userId,
          commentContent: content.trim()
        });
      }
    } else {
      // New comment on source - notify source owner
      const source = await this.sourceModel.findOne({ workId, sourceId }).exec();
      if (source && source.provenance?.uploadedByUserId && source.provenance.uploadedByUserId !== userId) {
        await this.notifications.queueSourceComment({
          workId,
          sourceId,
          revisionId,
          commentId,
          recipientUserId: source.provenance.uploadedByUserId,
          actorUserId: userId,
          commentContent: content.trim()
        });
      }
    }

    return { commentId, createdAt: now };
  }

  /**
   * Get comments for a revision (with vote info for current user)
   */
  async getComments(
    revisionId: string,
    currentUserId?: string
  ): Promise<any[]> {
    const comments = await this.revisionCommentModel
      .find({ revisionId, deleted: { $ne: true } })
      .sort({ voteScore: -1, createdAt: -1 })
      .exec();

    // Get user votes if authenticated
    let userVotes: Map<string, 'up' | 'down'> = new Map();
    if (currentUserId) {
      const votes = await this.revisionCommentVoteModel
        .find({
          commentId: { $in: comments.map(c => c.commentId) },
          userId: currentUserId
        })
        .exec();

      votes.forEach(v => userVotes.set(v.commentId, v.voteType));
    }

    // Get usernames
    const userIds = [...new Set(comments.map(c => c.userId))];
    const userMap = new Map<string, string>();
    for (const uid of userIds) {
      try {
        const user = await this.usersService.findById(uid);
        if (user) {
          userMap.set(uid, user.username || user.email || 'Unknown');
        }
      } catch {
        // ignore
      }
    }

    // Build nested structure (two-pass to handle any sort order)
    const commentMap = new Map();
    const result: any[] = [];

    // First pass: Build all comment objects and add to map
    comments.forEach(c => {
      const comment = {
        commentId: c.commentId,
        userId: c.userId,
        username: userMap.get(c.userId) || 'Unknown',
        content: c.content,
        voteScore: c.voteScore,
        createdAt: c.createdAt,
        editedAt: c.editedAt,
        flagged: c.flagged,
        userVote: userVotes.get(c.commentId),
        replies: []
      };

      commentMap.set(c.commentId, comment);
    });

    // Second pass: Build nested structure
    comments.forEach(c => {
      const comment = commentMap.get(c.commentId);
      if (c.parentCommentId) {
        const parent = commentMap.get(c.parentCommentId);
        if (parent) {
          parent.replies.push(comment);
        }
      } else {
        result.push(comment);
      }
    });

    return result;
  }

  /**
   * Update a comment (user must own it)
   */
  async updateComment(
    commentId: string,
    userId: string,
    content: string
  ): Promise<{ ok: true; editedAt: Date }> {
    if (!content || !content.trim()) {
      throw new BadRequestException('Comment content is required');
    }

    const now = new Date();
    const updated = await this.revisionCommentModel
      .findOneAndUpdate(
        { commentId, userId, deleted: { $ne: true } },
        { $set: { content: content.trim(), editedAt: now } },
        { new: true }
      )
      .exec();

    if (!updated) {
      throw new NotFoundException('Comment not found or you do not have permission to edit it');
    }

    return { ok: true, editedAt: now };
  }

  /**
   * Delete a comment (soft delete - user must own it or be admin)
   */
  async deleteComment(
    commentId: string,
    userId: string,
    isAdmin: boolean
  ): Promise<{ ok: true }> {
    const comment = await this.revisionCommentModel
      .findOne({ commentId })
      .exec();

    if (!comment || comment.deleted) {
      throw new NotFoundException('Comment not found');
    }

    if (!isAdmin && comment.userId !== userId) {
      throw new ForbiddenException('You do not have permission to delete this comment');
    }

    const now = new Date();
    await this.revisionCommentModel
      .updateOne(
        { commentId },
        { $set: { deleted: true, deletedAt: now, content: '[deleted]' } }
      )
      .exec();

    return { ok: true };
  }

  /**
   * Vote on a comment (upvote or downvote)
   */
  async voteComment(
    commentId: string,
    userId: string,
    voteType: 'up' | 'down'
  ): Promise<{ ok: true; newScore: number }> {
    const comment = await this.revisionCommentModel
      .findOne({ commentId, deleted: { $ne: true } })
      .exec();

    if (!comment) {
      throw new NotFoundException('Comment not found');
    }

    // Check existing vote
    const existingVote = await this.revisionCommentVoteModel
      .findOne({ commentId, userId })
      .exec();

    const now = new Date();

    if (existingVote) {
      if (existingVote.voteType === voteType) {
        // Remove vote (toggle off)
        await this.revisionCommentVoteModel.deleteOne({ commentId, userId }).exec();
        const scoreChange = voteType === 'up' ? -1 : 1;
        comment.voteScore += scoreChange;
      } else {
        // Change vote
        existingVote.voteType = voteType;
        existingVote.votedAt = now;
        await existingVote.save();
        const scoreChange = voteType === 'up' ? 2 : -2; // From -1 to +1 or vice versa
        comment.voteScore += scoreChange;
      }
    } else {
      // New vote
      await this.revisionCommentVoteModel.create({
        commentId,
        userId,
        voteType,
        votedAt: now
      });
      comment.voteScore += voteType === 'up' ? 1 : -1;
    }

    await comment.save();

    return { ok: true, newScore: comment.voteScore };
  }

  /**
   * Flag a comment for review
   */
  async flagComment(
    commentId: string,
    userId: string,
    reason: string
  ): Promise<{ ok: true }> {
    if (!reason || !reason.trim()) {
      throw new BadRequestException('Flag reason is required');
    }

    const comment = await this.revisionCommentModel
      .findOne({ commentId, deleted: { $ne: true } })
      .exec();

    if (!comment) {
      throw new NotFoundException('Comment not found');
    }

    const now = new Date();
    await this.revisionCommentModel
      .updateOne(
        { commentId },
        {
          $set: {
            flagged: true,
            flaggedBy: userId,
            flaggedAt: now,
            flagReason: reason.trim()
          }
        }
      )
      .exec();

    return { ok: true };
  }

  /**
   * Remove flag from comment (admin only)
   */
  async unflagComment(
    commentId: string
  ): Promise<{ ok: true }> {
    const comment = await this.revisionCommentModel
      .findOne({ commentId })
      .exec();

    if (!comment) {
      throw new NotFoundException('Comment not found');
    }

    await this.revisionCommentModel
      .updateOne(
        { commentId },
        {
          $set: {
            flagged: false,
            flaggedBy: undefined,
            flaggedAt: undefined,
            flagReason: undefined
          }
        }
      )
      .exec();

    return { ok: true };
  }

  /**
   * Get all flagged comments (admin only)
   */
  async getFlaggedComments(): Promise<any[]> {
    const comments = await this.revisionCommentModel
      .find({ flagged: true, deleted: { $ne: true } })
      .sort({ flaggedAt: -1 })
      .exec();

    // Get usernames for comment authors and flaggers
    const userIds = [
      ...new Set([
        ...comments.map(c => c.userId),
        ...comments.map(c => c.flaggedBy).filter(Boolean)
      ])
    ] as string[];

    const userMap = new Map<string, string>();
    for (const uid of userIds) {
      try {
        const user = await this.usersService.findById(uid);
        if (user) {
          userMap.set(uid, user.username || user.email || 'Unknown');
        }
      } catch {
        // ignore
      }
    }

    // Get revision info
    const revisionIds = [...new Set(comments.map(c => c.revisionId))];
    const revisions = await this.sourceRevisionModel
      .find({ revisionId: { $in: revisionIds } })
      .exec();
    const revisionMap = new Map(revisions.map(r => [r.revisionId, r]));

    return comments.map(c => {
      const revision = revisionMap.get(c.revisionId);
      return {
        commentId: c.commentId,
        workId: c.workId,
        sourceId: c.sourceId,
        revisionId: c.revisionId,
        revisionSeq: revision?.sequenceNumber,
        userId: c.userId,
        username: userMap.get(c.userId) || 'Unknown',
        content: c.content,
        voteScore: c.voteScore,
        createdAt: c.createdAt,
        flaggedBy: c.flaggedBy,
        flaggedByUsername: c.flaggedBy ? userMap.get(c.flaggedBy) || 'Unknown' : undefined,
        flaggedAt: c.flaggedAt,
        flagReason: c.flagReason
      };
    });
  }
}
