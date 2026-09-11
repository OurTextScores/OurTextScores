import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  ScannerFindingDisposition,
  ScannerFindingDisposition_,
  ScannerFindingDispositionDocument
} from './schemas/scanner-finding-disposition.schema';
import { StandingDisposition } from './scanner-finding-dispositions';

export interface SetDispositionInput {
  jobId: string;
  kind: string;
  /** `null` for every part of this kind. */
  part?: string | null;
  disposition: ScannerFindingDisposition;
  userHash: string;
  profileRevision?: number;
  findingCount?: number;
}

/**
 * The standing review decisions for a job.
 *
 * Design: `docs/private/SCANNER_FINDINGS_REVIEW_EDITOR_DESIGN_2026-09-10.md`.
 *
 * Thin on purpose: the rules about which decision covers which finding live in
 * `scanner-finding-dispositions.ts` and are tested without a database. This only reads
 * and writes them.
 */
@Injectable()
export class ScannerFindingDispositionService {
  constructor(
    @InjectModel(ScannerFindingDisposition_.name)
    private readonly model: Model<ScannerFindingDispositionDocument>
  ) {}

  /**
   * Record or replace the standing decision for one finding class.
   *
   * Upsert rather than insert: simultaneous review is not a supported use case, so a
   * reviewer changing their mind should leave one current answer rather than a history
   * nothing reads. `timestamps` keeps when it last changed.
   */
  async set(input: SetDispositionInput): Promise<ScannerFindingDisposition_> {
    const part = input.part ?? null;
    return this.model
      .findOneAndUpdate(
        { jobId: input.jobId, kind: input.kind, part },
        {
          $set: {
            disposition: input.disposition,
            userHash: input.userHash,
            ...(input.profileRevision === undefined
              ? {}
              : { profileRevision: input.profileRevision }),
            ...(input.findingCount === undefined ? {} : { findingCount: input.findingCount })
          },
          $setOnInsert: { jobId: input.jobId, kind: input.kind, part }
        },
        { upsert: true, new: true }
      )
      .lean<ScannerFindingDisposition_>()
      .exec();
  }

  /**
   * Withdraw a decision, returning the finding to open work.
   *
   * Suppression must be reversible: a reviewer who acknowledged a category and then
   * realised it mattered has no other way back, and the findings themselves were never
   * deleted, so there is nothing to restore beyond this row.
   */
  async clear(jobId: string, kind: string, part?: string | null): Promise<boolean> {
    const result = await this.model
      .deleteOne({ jobId, kind, part: part ?? null })
      .exec();
    return result.deletedCount > 0;
  }

  async list(jobId: string): Promise<StandingDisposition[]> {
    const rows = await this.model
      .find({ jobId })
      .sort({ kind: 1, part: 1 })
      .lean<Array<ScannerFindingDisposition_ & { updatedAt?: Date }>>()
      .exec();
    return rows.map((row) => ({
      kind: row.kind,
      part: row.part ?? null,
      disposition: row.disposition,
      updatedAt: row.updatedAt
    }));
  }

  /** Every job that carries a decision of this kind; for looking at review behaviour. */
  async countByDisposition(jobId: string): Promise<Record<string, number>> {
    const rows = await this.model.find({ jobId }).lean<ScannerFindingDisposition_[]>().exec();
    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.disposition] = (counts[row.disposition] ?? 0) + 1;
    }
    return counts;
  }
}
