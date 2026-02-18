import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createReadStream, promises as fs } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { ConfigService } from '@nestjs/config';
import { PdmxRecord, PdmxRecordDocument } from './schemas/pdmx-record.schema';
import type { RequestUser } from '../auth/types/auth-user';
import { ProjectsService } from '../projects/projects.service';
import { WorksService } from '../works/works.service';

@Injectable()
export class PdmxService {
  private readonly allowedLicenses = new Set([
    'CC0',
    'CC-BY-4.0',
    'CC-BY-SA-4.0',
    'CC-BY-NC-4.0',
    'CC-BY-NC-SA-4.0',
    'CC-BY-ND-4.0',
    'Public Domain',
    'All Rights Reserved',
    'Other'
  ]);

  constructor(
    @InjectModel(PdmxRecord.name)
    private readonly pdmxModel: Model<PdmxRecordDocument>,
    private readonly projectsService: ProjectsService,
    private readonly worksService: WorksService,
    private readonly config: ConfigService
  ) {}

  private buildRecordQuery(options?: {
    q?: string;
    group?: string;
    excludeUnacceptable?: boolean;
    requireNoLicenseConflict?: boolean;
    importStatus?: string;
    hideImported?: boolean;
    hasPdf?: boolean;
    subset?: string | string[];
  }): Record<string, any> {
    const query: Record<string, any> = {};
    const q = (options?.q || '').trim();
    if (q) {
      const regex = new RegExp(this.escapeRegex(q), 'i');
      query.$or = [
        { title: regex },
        { songName: regex },
        { composerName: regex },
        { artistName: regex },
        { pdmxId: regex }
      ];
    }

    const groupToken = this.normalizeGroupToken(options?.group || '');
    if (groupToken) {
      query.groups = { $regex: this.buildGroupRegex(groupToken) };
    }

    const excludeUnacceptable = options?.excludeUnacceptable !== false;
    if (excludeUnacceptable) {
      query['review.qualityStatus'] = { $ne: 'unacceptable' };
      query['review.excludedFromSearch'] = { $ne: true };
    }

    const requireNoLicenseConflict = options?.requireNoLicenseConflict !== false;
    if (requireNoLicenseConflict) {
      query['subsets.noLicenseConflict'] = true;
    }

    const importStatus = (options?.importStatus || '').trim();
    if (importStatus) {
      query['import.status'] = importStatus;
    }

    if (options?.hideImported === true) {
      query['import.status'] = { $ne: 'imported' };
    }

    if (typeof options?.hasPdf === 'boolean') {
      if (options.hasPdf) {
        query['assets.pdfPath'] = { $exists: true, $ne: '' };
      } else {
        query.$and = [
          ...(query.$and || []),
          {
            $or: [{ 'assets.pdfPath': { $exists: false } }, { 'assets.pdfPath': '' }]
          }
        ];
      }
    }

    const subsets = this.parseSubsetFilter(options?.subset);
    for (const subset of subsets) {
      const key = this.mapSubsetKey(subset);
      if (key) {
        query[key] = true;
      }
    }
    return query;
  }

  async listRecords(options?: {
    q?: string;
    group?: string;
    limit?: number;
    offset?: number;
    sort?: string;
    excludeUnacceptable?: boolean;
    requireNoLicenseConflict?: boolean;
    importStatus?: string;
    hideImported?: boolean;
    hasPdf?: boolean;
    subset?: string | string[];
  }): Promise<{ items: any[]; total: number; limit: number; offset: number }> {
    const limit = Math.max(1, Math.min(options?.limit ?? 50, 200));
    const offset = Math.max(0, options?.offset ?? 0);
    const sort = this.resolveSort(options?.sort);
    const query = this.buildRecordQuery(options);

    const projection = {
      pdmxId: 1,
      title: 1,
      songName: 1,
      artistName: 1,
      composerName: 1,
      license: 1,
      licenseConflict: 1,
      rating: 1,
      nViews: 1,
      nRatings: 1,
      nNotes: 1,
      subsets: 1,
      review: 1,
      import: 1,
      assets: 1,
      updatedAt: 1
    };

    const [total, items] = await Promise.all([
      this.pdmxModel.countDocuments(query).exec(),
      this.pdmxModel
        .find(query)
        .select(projection)
        .sort(sort)
        .skip(offset)
        .limit(limit)
        .lean()
        .exec()
    ]);

    return {
      items: items.map((item: any) => ({
        ...item,
        hasPdf: Boolean(item?.assets?.pdfPath),
        hasMxl: Boolean(item?.assets?.mxlPath)
      })),
      total,
      limit,
      offset
    };
  }

  async listGroups(options?: {
    q?: string;
    limit?: number;
    offset?: number;
    excludeUnacceptable?: boolean;
    requireNoLicenseConflict?: boolean;
    importStatus?: string;
    hideImported?: boolean;
    hasPdf?: boolean;
    subset?: string | string[];
    groupQ?: string;
  }): Promise<{
    items: Array<{
      group: string;
      count: number;
      unacceptableCount: number;
      excludedCount: number;
      importedCount: number;
      withPdfCount: number;
      noLicenseConflictCount: number;
    }>;
    totalGroups: number;
    limit: number;
    offset: number;
  }> {
    const limit = Math.max(1, Math.min(options?.limit ?? 30, 200));
    const offset = Math.max(0, options?.offset ?? 0);
    const baseQuery = this.buildRecordQuery(options);
    const groupQ = (options?.groupQ || '').trim().toLowerCase();

    const pipeline: any[] = [
      { $match: baseQuery },
      { $match: { groups: { $exists: true, $type: 'string', $nin: ['', 'NA', 'na'] } } },
      {
        $project: {
          tokens: {
            $setUnion: [
              {
                $filter: {
                  input: {
                    $map: {
                      input: { $split: [{ $toLower: '$groups' }, '-'] },
                      as: 'token',
                      in: { $trim: { input: '$$token' } }
                    }
                  },
                  as: 'token',
                  cond: { $gt: [{ $strLenCP: '$$token' }, 2] }
                }
              },
              []
            ]
          },
          review: 1,
          import: 1,
          assets: 1,
          subsets: 1
        }
      },
      { $unwind: '$tokens' }
    ];

    if (groupQ) {
      pipeline.push({ $match: { tokens: { $regex: this.escapeRegex(groupQ), $options: 'i' } } });
    }

    pipeline.push(
      {
        $group: {
          _id: '$tokens',
          count: { $sum: 1 },
          unacceptableCount: {
            $sum: { $cond: [{ $eq: ['$review.qualityStatus', 'unacceptable'] }, 1, 0] }
          },
          excludedCount: {
            $sum: { $cond: [{ $eq: ['$review.excludedFromSearch', true] }, 1, 0] }
          },
          importedCount: {
            $sum: { $cond: [{ $eq: ['$import.status', 'imported'] }, 1, 0] }
          },
          withPdfCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: ['$assets.pdfPath', null] },
                    { $ne: ['$assets.pdfPath', ''] }
                  ]
                },
                1,
                0
              ]
            }
          },
          noLicenseConflictCount: {
            $sum: { $cond: [{ $eq: ['$subsets.noLicenseConflict', true] }, 1, 0] }
          }
        }
      },
      { $sort: { count: -1, _id: 1 } },
      {
        $facet: {
          items: [{ $skip: offset }, { $limit: limit }],
          meta: [{ $count: 'totalGroups' }]
        }
      }
    );

    const [result] = await this.pdmxModel.aggregate(pipeline).exec();
    const items = Array.isArray(result?.items) ? result.items : [];
    const totalGroups = Number(result?.meta?.[0]?.totalGroups || 0);
    return {
      items: items.map((item: any) => ({
        group: String(item?._id || ''),
        count: Number(item?.count || 0),
        unacceptableCount: Number(item?.unacceptableCount || 0),
        excludedCount: Number(item?.excludedCount || 0),
        importedCount: Number(item?.importedCount || 0),
        withPdfCount: Number(item?.withPdfCount || 0),
        noLicenseConflictCount: Number(item?.noLicenseConflictCount || 0)
      })),
      totalGroups,
      limit,
      offset
    };
  }

  async getRecord(pdmxId: string): Promise<any> {
    const id = (pdmxId || '').trim();
    if (!id) throw new BadRequestException('pdmxId is required');
    const doc = await this.pdmxModel.findOne({ pdmxId: id }).lean().exec();
    if (!doc) throw new NotFoundException('PDMX record not found');
    return {
      ...doc,
      hasPdf: Boolean((doc as any)?.assets?.pdfPath),
      hasMxl: Boolean((doc as any)?.assets?.mxlPath)
    };
  }

  async getPdfStream(pdmxId: string): Promise<{ stream: NodeJS.ReadableStream; filename: string }> {
    const record = await this.getRecord(pdmxId);
    const rel = String(record?.assets?.pdfPath || '').trim();
    if (!rel) throw new NotFoundException('PDF path not available for this PDMX record');
    const fullPath = this.resolveAssetPath(rel);

    const stat = await fs.stat(fullPath).catch(() => null);
    if (!stat || !stat.isFile()) {
      throw new NotFoundException('PDMX PDF file not found on server');
    }

    return {
      stream: createReadStream(fullPath),
      filename: basename(fullPath)
    };
  }

  async updateReview(
    pdmxId: string,
    payload: {
      qualityStatus?: 'unknown' | 'acceptable' | 'unacceptable';
      excludedFromSearch?: boolean;
      reason?: string;
      notes?: string;
    },
    actor: RequestUser
  ): Promise<any> {
    const id = (pdmxId || '').trim();
    if (!id) throw new BadRequestException('pdmxId is required');

    const set: Record<string, unknown> = {
      'review.updatedBy': actor.userId,
      'review.updatedAt': new Date()
    };
    const unset: Record<string, ''> = {};

    if (payload.qualityStatus !== undefined) {
      const allowed = new Set(['unknown', 'acceptable', 'unacceptable']);
      if (!allowed.has(payload.qualityStatus)) {
        throw new BadRequestException('Invalid qualityStatus');
      }
      set['review.qualityStatus'] = payload.qualityStatus;
      if (payload.qualityStatus === 'unacceptable' && payload.excludedFromSearch === undefined) {
        set['review.excludedFromSearch'] = true;
      }
    }

    if (payload.excludedFromSearch !== undefined) {
      set['review.excludedFromSearch'] = payload.excludedFromSearch === true;
    }

    if (payload.reason !== undefined) {
      const reason = payload.reason?.trim();
      if (reason) {
        set['review.reason'] = reason;
      } else {
        unset['review.reason'] = '';
      }
    }

    if (payload.notes !== undefined) {
      const notes = payload.notes?.trim();
      if (notes) {
        set['review.notes'] = notes;
      } else {
        unset['review.notes'] = '';
      }
    }

    const update: Record<string, any> = { $set: set };
    if (Object.keys(unset).length > 0) {
      update.$unset = unset;
    }

    const updated = await this.pdmxModel
      .findOneAndUpdate({ pdmxId: id }, update, { new: true })
      .lean()
      .exec();
    if (!updated) throw new NotFoundException('PDMX record not found');
    return updated;
  }

  async markGroupUnacceptable(
    group: string,
    payload: {
      reason?: string;
      notes?: string;
    },
    actor: RequestUser
  ): Promise<{
    ok: boolean;
    group: string;
    matchedCount: number;
    modifiedCount: number;
  }> {
    const normalized = this.normalizeGroupToken(group);
    if (!normalized) {
      throw new BadRequestException('group is required');
    }

    const reason = (payload.reason || '').trim() || `Marked unacceptable by group (${normalized})`;
    const notes = (payload.notes || '').trim();
    const query = {
      groups: {
        $regex: this.buildGroupRegex(normalized)
      }
    };
    const update: Record<string, any> = {
      $set: {
        'review.qualityStatus': 'unacceptable',
        'review.excludedFromSearch': true,
        'review.reason': reason,
        'review.updatedBy': actor.userId,
        'review.updatedAt': new Date()
      }
    };
    if (notes) {
      update.$set['review.notes'] = notes;
    } else {
      update.$unset = { 'review.notes': '' };
    }

    const result = await this.pdmxModel.updateMany(query, update).exec();
    return {
      ok: true,
      group: normalized,
      matchedCount: Number((result as any)?.matchedCount || 0),
      modifiedCount: Number((result as any)?.modifiedCount || 0)
    };
  }

  async updateImportState(
    pdmxId: string,
    payload: {
      status?: 'not_imported' | 'imported' | 'failed';
      importedWorkId?: string;
      importedSourceId?: string;
      importedRevisionId?: string;
      importedProjectId?: string;
      imslpUrl?: string;
      error?: string;
    },
    actor: RequestUser
  ): Promise<any> {
    const id = (pdmxId || '').trim();
    if (!id) throw new BadRequestException('pdmxId is required');

    const set: Record<string, unknown> = {
      'import.updatedAt': new Date(),
      'import.updatedBy': actor.userId
    };
    const unset: Record<string, ''> = {};

    if (payload.status) {
      const allowed = new Set(['not_imported', 'imported', 'failed']);
      if (!allowed.has(payload.status)) {
        throw new BadRequestException('Invalid import status');
      }
      set['import.status'] = payload.status;
      if (payload.status === 'not_imported') {
        unset['import.importedWorkId'] = '';
        unset['import.importedSourceId'] = '';
        unset['import.importedRevisionId'] = '';
        unset['import.importedProjectId'] = '';
        unset['import.imslpUrl'] = '';
        unset['import.error'] = '';
      }
    }

    if (payload.importedWorkId !== undefined) {
      const workId = payload.importedWorkId?.trim();
      if (workId) set['import.importedWorkId'] = workId;
      else unset['import.importedWorkId'] = '';
    }
    if (payload.importedSourceId !== undefined) {
      const sourceId = payload.importedSourceId?.trim();
      if (sourceId) set['import.importedSourceId'] = sourceId;
      else unset['import.importedSourceId'] = '';
    }
    if (payload.importedRevisionId !== undefined) {
      const revisionId = payload.importedRevisionId?.trim();
      if (revisionId) set['import.importedRevisionId'] = revisionId;
      else unset['import.importedRevisionId'] = '';
    }
    if (payload.importedProjectId !== undefined) {
      const projectId = payload.importedProjectId?.trim();
      if (projectId) set['import.importedProjectId'] = projectId;
      else unset['import.importedProjectId'] = '';
    }
    if (payload.imslpUrl !== undefined) {
      const imslpUrl = payload.imslpUrl?.trim();
      if (imslpUrl) set['import.imslpUrl'] = imslpUrl;
      else unset['import.imslpUrl'] = '';
    }
    if (payload.error !== undefined) {
      const importError = payload.error?.trim();
      if (importError) set['import.error'] = importError;
      else unset['import.error'] = '';
    }

    const update: Record<string, any> = { $set: set };
    if (Object.keys(unset).length > 0) {
      update.$unset = unset;
    }

    const updated = await this.pdmxModel
      .findOneAndUpdate({ pdmxId: id }, update, { new: true })
      .lean()
      .exec();
    if (!updated) throw new NotFoundException('PDMX record not found');
    return updated;
  }

  async associateSource(
    pdmxId: string,
    payload: {
      imslpUrl: string;
      projectId: string;
      sourceLabel?: string;
      sourceType?: 'score' | 'parts' | 'audio' | 'metadata' | 'other';
      license?: string;
      adminVerified?: boolean;
    },
    actor: RequestUser,
    referencePdfFile?: Express.Multer.File,
    progressId?: string
  ): Promise<any> {
    const id = (pdmxId || '').trim();
    if (!id) throw new BadRequestException('pdmxId is required');
    const imslpUrl = (payload.imslpUrl || '').trim();
    const projectId = (payload.projectId || '').trim();
    const license = this.resolveLicense(payload.license);
    const adminVerified = payload.adminVerified === true;
    if (!imslpUrl) throw new BadRequestException('imslpUrl is required');
    if (!projectId) throw new BadRequestException('projectId is required');

    const existing = await this.pdmxModel.findOne({ pdmxId: id }).lean().exec();
    if (!existing) throw new NotFoundException('PDMX record not found');
    if ((existing as any)?.import?.status === 'imported' && (existing as any)?.import?.importedWorkId && (existing as any)?.import?.importedSourceId) {
      return {
        ok: true,
        alreadyImported: true,
        workId: (existing as any).import.importedWorkId,
        sourceId: (existing as any).import.importedSourceId,
        revisionId: (existing as any).import.importedRevisionId
      };
    }

    const lock = await this.pdmxModel
      .findOneAndUpdate(
        {
          pdmxId: id,
          $or: [
            { 'import.status': { $exists: false } },
            { 'import.status': 'not_imported' },
            { 'import.status': 'failed' }
          ]
        },
        {
          $set: {
            'import.status': 'importing',
            'import.updatedAt': new Date(),
            'import.updatedBy': actor.userId,
            'import.importedProjectId': projectId,
            'import.imslpUrl': imslpUrl
          },
          $unset: {
            'import.error': ''
          }
        },
        { new: true }
      )
      .lean()
      .exec();

    if (!lock) {
      const latest = await this.pdmxModel.findOne({ pdmxId: id }).lean().exec();
      if ((latest as any)?.import?.status === 'imported') {
        return {
          ok: true,
          alreadyImported: true,
          workId: (latest as any)?.import?.importedWorkId,
          sourceId: (latest as any)?.import?.importedSourceId,
          revisionId: (latest as any)?.import?.importedRevisionId
        };
      }
      throw new ConflictException('This PDMX record is currently being imported');
    }

    try {
      const relMxlPath = String((lock as any)?.assets?.mxlPath || '').trim();
      if (!relMxlPath) {
        throw new NotFoundException('PDMX MXL path not available for this record');
      }

      const fullMxlPath = this.resolveAssetPath(relMxlPath);
      const stat = await fs.stat(fullMxlPath).catch(() => null);
      if (!stat || !stat.isFile()) {
        throw new NotFoundException('PDMX MXL file not found on server');
      }

      const buffer = await fs.readFile(fullMxlPath);
      const sourceLabel = payload.sourceLabel?.trim() || (lock as any)?.title || (lock as any)?.songName || `PDMX ${id}`;
      const sourceType = payload.sourceType || 'score';

      const file: Express.Multer.File = {
        fieldname: 'file',
        originalname: basename(fullMxlPath),
        encoding: '7bit',
        mimetype: 'application/vnd.recordare.musicxml',
        size: buffer.byteLength,
        destination: '',
        filename: basename(fullMxlPath),
        path: fullMxlPath,
        buffer,
        stream: Readable.from(buffer)
      } as Express.Multer.File;

      const upload = await this.projectsService.uploadSource(
        projectId,
        {
          imslpUrl,
          label: sourceLabel,
          sourceType,
          license,
          formatHint: 'mxl',
          commitMessage: `Import from PDMX record ${id}`,
          description: this.buildImportDescription(lock as any)
        },
        file,
        referencePdfFile,
        undefined,
        progressId,
        {
          userId: actor.userId,
          roles: actor.roles,
          name: actor.name,
          email: actor.email
        }
      );

      if (adminVerified) {
        await this.worksService.verifySource(
          upload.workId,
          upload.sourceId,
          actor.userId,
          `Verified during PDMX import (${id})`
        );
      }

      await this.pdmxModel.updateOne(
        { pdmxId: id },
        {
          $set: {
            'import.status': 'imported',
            'import.importedWorkId': upload.workId,
            'import.importedSourceId': upload.sourceId,
            'import.importedRevisionId': upload.revisionId,
            'import.importedProjectId': projectId,
            'import.imslpUrl': imslpUrl,
            'import.updatedBy': actor.userId,
            'import.updatedAt': new Date()
          },
          $unset: {
            'import.error': ''
          }
        }
      ).exec();

      return {
        ok: true,
        workId: upload.workId,
        sourceId: upload.sourceId,
        revisionId: upload.revisionId,
        projectId
      };
    } catch (error: any) {
      await this.pdmxModel
        .updateOne(
          { pdmxId: id },
          {
            $set: {
              'import.status': 'failed',
              'import.error': this.readableError(error),
              'import.updatedAt': new Date()
            }
          }
        )
        .exec();
      throw error;
    }
  }

  private getStorageRoot(): string {
    const root = this.config.get<string>('PDMX_STORAGE_ROOT')?.trim();
    if (!root) {
      throw new BadRequestException('PDMX_STORAGE_ROOT is not configured');
    }
    return resolve(root);
  }

  private resolveAssetPath(relativePath: string): string {
    const root = this.getStorageRoot();
    const rel = relativePath.replace(/^\.\//, '').replace(/^\//, '');
    const fullPath = resolve(join(root, rel));
    const rootPrefix = root.endsWith('/') ? root : `${root}/`;
    if (fullPath !== root && !fullPath.startsWith(rootPrefix)) {
      throw new BadRequestException('Invalid PDMX asset path');
    }
    return fullPath;
  }

  private parseSubsetFilter(value?: string | string[]): string[] {
    if (!value) return [];
    const list = Array.isArray(value) ? value : String(value).split(',');
    return Array.from(new Set(list.map((item) => item.trim()).filter(Boolean)));
  }

  private mapSubsetKey(subset: string): string | null {
    const normalized = subset.trim().toLowerCase();
    if (normalized === 'all') return 'subsets.all';
    if (normalized === 'rated') return 'subsets.rated';
    if (normalized === 'deduplicated') return 'subsets.deduplicated';
    if (normalized === 'rated_deduplicated') return 'subsets.ratedDeduplicated';
    if (normalized === 'no_license_conflict') return 'subsets.noLicenseConflict';
    if (normalized === 'all_valid') return 'subsets.allValid';
    return null;
  }

  private resolveSort(sort?: string): Record<string, 1 | -1> {
    switch ((sort || '').trim()) {
      case 'title_asc':
        return { title: 1, pdmxId: 1 };
      case 'rating_desc':
        return { rating: -1, nRatings: -1, pdmxId: 1 };
      case 'n_notes_desc':
        return { nNotes: -1, pdmxId: 1 };
      case 'updated_desc':
        return { updatedAt: -1, pdmxId: 1 };
      default:
        return { updatedAt: -1, pdmxId: 1 };
    }
  }

  private normalizeGroupToken(group: string): string {
    return String(group || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '');
  }

  private buildGroupRegex(group: string): RegExp {
    return new RegExp(`(^|-)${this.escapeRegex(group)}(-|$)`, 'i');
  }

  private buildImportDescription(record: {
    pdmxId?: string;
    title?: string;
    songName?: string;
    composerName?: string;
    artistName?: string;
    license?: string;
  }): string {
    const lines = [
      `Imported from PDMX record ${record?.pdmxId || 'unknown'}`,
      record?.title ? `Title: ${record.title}` : '',
      record?.songName ? `Song: ${record.songName}` : '',
      record?.composerName ? `Composer: ${record.composerName}` : '',
      record?.artistName ? `Artist: ${record.artistName}` : '',
      record?.license ? `License: ${record.license}` : ''
    ].filter(Boolean);
    return lines.join('\n');
  }

  private resolveLicense(license?: string): string {
    const trimmed = (license || '').trim();
    if (!trimmed) return 'Public Domain';
    if (!this.allowedLicenses.has(trimmed)) {
      throw new BadRequestException('Invalid license value');
    }
    return trimmed;
  }

  private escapeRegex(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private readableError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error || 'unknown error');
  }
}
