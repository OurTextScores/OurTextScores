import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { SourceBranch, SourceBranchDocument, BranchPolicy } from './schemas/source-branch.schema';

export interface BranchView {
  name: string;
  policy: BranchPolicy;
  ownerUserId?: string;
  baseRevisionId?: string;
}

@Injectable()
export class BranchesService {
  constructor(
    @InjectModel(SourceBranch.name)
    private readonly branchModel: Model<SourceBranchDocument>
  ) {}

  sanitizeName(name?: string): string {
    const raw = (name ?? '').trim();
    if (!raw) return 'main';
    return raw.replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) || 'main';
  }

  async listBranches(workId: string, sourceId: string): Promise<BranchView[]> {
    const docs = await this.branchModel.find({ workId, sourceId }).sort({ name: 1 }).lean().exec();
    if (!docs || docs.length === 0) {
      return [{ name: 'main', policy: 'public' }];
    }
    return docs.map((d) => ({ name: d.name, policy: d.policy, ownerUserId: d.ownerUserId ?? undefined, baseRevisionId: d.baseRevisionId ?? undefined }));
  }

  async ensureDefaultMain(workId: string, sourceId: string): Promise<void> {
    const existing = await this.branchModel.findOne({ workId, sourceId, name: 'main' }).lean().exec();
    if (!existing) {
      await this.branchModel.create({ workId, sourceId, name: 'main', policy: 'public' });
    }
  }

  async createBranch(params: { workId: string; sourceId: string; name: string; policy: BranchPolicy; ownerUserId?: string; baseRevisionId?: string }): Promise<BranchView> {
    const name = this.sanitizeName(params.name);
    const doc = await this.branchModel.create({ workId: params.workId, sourceId: params.sourceId, name, policy: params.policy, ownerUserId: params.ownerUserId, baseRevisionId: params.baseRevisionId });
    return { name: doc.name, policy: doc.policy, ownerUserId: doc.ownerUserId ?? undefined, baseRevisionId: doc.baseRevisionId ?? undefined };
  }

  async updateBranch(
    workId: string,
    sourceId: string,
    name: string,
    updates: { policy?: BranchPolicy; ownerUserId?: string },
    actor: { userId: string; roles?: string[] }
  ): Promise<BranchView> {
    const branch = await this.branchModel.findOne({ workId, sourceId, name }).exec();
    if (!branch) throw new NotFoundException('Branch not found');

    const isOwner = branch.ownerUserId && actor.userId === branch.ownerUserId;
    const isAdmin = (actor.roles ?? []).includes('admin');
    if (!isOwner && !isAdmin) {
      throw new ForbiddenException('Only owner or admin can modify branch');
    }

    if (updates.policy !== undefined) branch.policy = updates.policy;
    if (updates.ownerUserId !== undefined) branch.ownerUserId = updates.ownerUserId || undefined;
    await branch.save();
    return { name: branch.name, policy: branch.policy, ownerUserId: branch.ownerUserId ?? undefined, baseRevisionId: branch.baseRevisionId ?? undefined };
  }

  async getBranchPolicy(workId: string, sourceId: string, name?: string): Promise<BranchPolicy> {
    const branchName = this.sanitizeName(name);
    const doc = await this.branchModel.findOne({ workId, sourceId, name: branchName }).lean().exec();
    return doc?.policy ?? 'public';
  }

  async getBranchOwnerUserId(workId: string, sourceId: string, name?: string): Promise<string | undefined> {
    const branchName = this.sanitizeName(name);
    const doc = await this.branchModel.findOne({ workId, sourceId, name: branchName }).lean().exec();
    return doc?.ownerUserId ?? undefined;
  }

  async deleteBranch(
    workId: string,
    sourceId: string,
    name: string,
    actor: { userId: string; roles?: string[] }
  ): Promise<{ deleted: boolean }> {
    const branchName = this.sanitizeName(name);
    const branch = await this.branchModel.findOne({ workId, sourceId, name: branchName }).exec();
    if (!branch) return { deleted: false };
    const isOwner = branch.ownerUserId && actor.userId === branch.ownerUserId;
    const isAdmin = (actor.roles ?? []).includes('admin');
    if (!isOwner && !isAdmin) {
      throw new ForbiddenException('Only owner or admin can delete branch');
    }
    // Do not allow deleting default main branch
    if (branch.name === 'main') return { deleted: false };
    await this.branchModel.deleteOne({ _id: branch._id }).exec();
    return { deleted: true };
  }
}
