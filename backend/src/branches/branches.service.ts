import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { SourceBranch, SourceBranchDocument, BranchPolicy, BranchLifecycle } from './schemas/source-branch.schema';

export interface BranchView {
  name: string;
  policy: BranchPolicy;
  lifecycle: BranchLifecycle;
  ownerUserId?: string;
  baseRevisionId?: string;
}

@Injectable()
export class BranchesService {
  private static readonly DEFAULT_BRANCH = 'trunk';
  private static readonly LEGACY_DEFAULT_BRANCH = 'main';

  constructor(
    @InjectModel(SourceBranch.name)
    private readonly branchModel: Model<SourceBranchDocument>
  ) {}

  sanitizeName(name?: string): string {
    const raw = (name ?? '').trim();
    if (!raw) return BranchesService.DEFAULT_BRANCH;
    const normalized = raw.replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
    if (!normalized) return BranchesService.DEFAULT_BRANCH;
    return normalized.toLowerCase() === BranchesService.LEGACY_DEFAULT_BRANCH
      ? BranchesService.DEFAULT_BRANCH
      : normalized;
  }

  private branchAliases(name: string): string[] {
    return name === BranchesService.DEFAULT_BRANCH
      ? [BranchesService.DEFAULT_BRANCH, BranchesService.LEGACY_DEFAULT_BRANCH]
      : [name];
  }

  private toBranchView(doc: {
    name: string;
    policy: BranchPolicy;
    lifecycle?: BranchLifecycle | null;
    ownerUserId?: string | null;
    baseRevisionId?: string | null;
  }): BranchView {
    return {
      name: doc.name === BranchesService.LEGACY_DEFAULT_BRANCH ? BranchesService.DEFAULT_BRANCH : doc.name,
      policy: doc.policy,
      lifecycle: doc.lifecycle ?? 'open',
      ownerUserId: doc.ownerUserId ?? undefined,
      baseRevisionId: doc.baseRevisionId ?? undefined
    };
  }

  private async findCanonicalBranch(
    workId: string,
    sourceId: string,
    name: string
  ): Promise<SourceBranchDocument | null> {
    const branchName = this.sanitizeName(name);
    return this.branchModel
      .findOne({ workId, sourceId, name: { $in: this.branchAliases(branchName) } })
      .exec();
  }

  async listBranches(workId: string, sourceId: string): Promise<BranchView[]> {
    const docs = await this.branchModel.find({ workId, sourceId }).sort({ name: 1 }).lean().exec();
    if (!docs || docs.length === 0) {
      return [{ name: BranchesService.DEFAULT_BRANCH, policy: 'public', lifecycle: 'open' }];
    }

    const deduped = new Map<string, BranchView>();
    for (const doc of docs) {
      const view = this.toBranchView(doc);
      const existing = deduped.get(view.name);
      if (!existing || doc.name === BranchesService.DEFAULT_BRANCH) {
        deduped.set(view.name, view);
      }
    }

    return Array.from(deduped.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  async ensureDefaultTrunk(workId: string, sourceId: string): Promise<void> {
    const existing = await this.branchModel
      .findOne({ workId, sourceId, name: { $in: this.branchAliases(BranchesService.DEFAULT_BRANCH) } })
      .lean()
      .exec();
    if (!existing) {
      await this.branchModel.create({ workId, sourceId, name: BranchesService.DEFAULT_BRANCH, policy: 'public', lifecycle: 'open' });
    }
  }

  async createBranch(params: { workId: string; sourceId: string; name: string; policy: BranchPolicy; ownerUserId?: string; baseRevisionId?: string }): Promise<BranchView> {
    const name = this.sanitizeName(params.name);
    const existing = await this.findCanonicalBranch(params.workId, params.sourceId, name);
    if (existing) {
      return this.toBranchView(existing);
    }
    const doc = await this.branchModel.create({ workId: params.workId, sourceId: params.sourceId, name, policy: params.policy, ownerUserId: params.ownerUserId, baseRevisionId: params.baseRevisionId, lifecycle: 'open' });
    return this.toBranchView(doc);
  }

  async updateBranch(
    workId: string,
    sourceId: string,
    name: string,
    updates: { policy?: BranchPolicy; ownerUserId?: string },
    actor: { userId: string; roles?: string[] }
  ): Promise<BranchView> {
    const branch = await this.findCanonicalBranch(workId, sourceId, name);
    if (!branch) throw new NotFoundException('Branch not found');

    const isOwner = branch.ownerUserId && actor.userId === branch.ownerUserId;
    const isAdmin = (actor.roles ?? []).includes('admin');
    if (!isOwner && !isAdmin) {
      throw new ForbiddenException('Only owner or admin can modify branch');
    }

    if (updates.policy !== undefined) branch.policy = updates.policy;
    if (updates.ownerUserId !== undefined) branch.ownerUserId = updates.ownerUserId || undefined;
    await branch.save();
    return this.toBranchView(branch);
  }

  async getBranchPolicy(workId: string, sourceId: string, name?: string): Promise<BranchPolicy> {
    const branchName = this.sanitizeName(name);
    const doc = await this.branchModel
      .findOne({ workId, sourceId, name: { $in: this.branchAliases(branchName) } })
      .lean()
      .exec();
    return doc?.policy ?? 'public';
  }

  async getBranchOwnerUserId(workId: string, sourceId: string, name?: string): Promise<string | undefined> {
    const branchName = this.sanitizeName(name);
    const doc = await this.branchModel
      .findOne({ workId, sourceId, name: { $in: this.branchAliases(branchName) } })
      .lean()
      .exec();
    return doc?.ownerUserId ?? undefined;
  }

  async getBranchLifecycle(workId: string, sourceId: string, name?: string): Promise<BranchLifecycle> {
    const branchName = this.sanitizeName(name);
    const doc = await this.branchModel
      .findOne({ workId, sourceId, name: { $in: this.branchAliases(branchName) } })
      .lean()
      .exec();
    return doc?.lifecycle ?? 'open';
  }

  async setBranchLifecycle(workId: string, sourceId: string, name: string, lifecycle: BranchLifecycle): Promise<BranchView> {
    const branchName = this.sanitizeName(name);
    await this.ensureDefaultTrunk(workId, sourceId);
    const doc = await this.branchModel
      .findOneAndUpdate(
        { workId, sourceId, name: { $in: this.branchAliases(branchName) } },
        { $set: { lifecycle } },
        { new: true },
      )
      .lean()
      .exec();
    if (!doc) {
      throw new NotFoundException('Branch not found');
    }
    return this.toBranchView(doc);
  }

  async migrateSource(
    oldWorkId: string,
    oldSourceId: string,
    newWorkId: string,
    newSourceId: string
  ): Promise<void> {
    await this.branchModel
      .updateMany(
        { workId: oldWorkId, sourceId: oldSourceId },
        { $set: { workId: newWorkId, sourceId: newSourceId } }
      )
      .exec();
  }

  async deleteBranch(
    workId: string,
    sourceId: string,
    name: string,
    actor: { userId: string; roles?: string[] }
  ): Promise<{ deleted: boolean }> {
    const branchName = this.sanitizeName(name);
    const branch = await this.findCanonicalBranch(workId, sourceId, branchName);
    if (!branch) return { deleted: false };
    const isOwner = branch.ownerUserId && actor.userId === branch.ownerUserId;
    const isAdmin = (actor.roles ?? []).includes('admin');
    if (!isOwner && !isAdmin) {
      throw new ForbiddenException('Only owner or admin can delete branch');
    }
    // Do not allow deleting default trunk branch
    if (this.toBranchView(branch).name === BranchesService.DEFAULT_BRANCH) return { deleted: false };
    await this.branchModel.deleteOne({ _id: branch._id }).exec();
    return { deleted: true };
  }
}
