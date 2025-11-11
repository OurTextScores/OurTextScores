import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { WatchSubscription, WatchSubscriptionDocument } from './schemas/watch.schema';

@Injectable()
export class WatchesService {
  constructor(
    @InjectModel(WatchSubscription.name)
    private readonly watchModel: Model<WatchSubscriptionDocument>
  ) {}

  async subscribe(userId: string, workId: string, sourceId: string): Promise<void> {
    await this.watchModel
      .findOneAndUpdate(
        { userId, workId, sourceId },
        { $setOnInsert: { userId, workId, sourceId } },
        { upsert: true }
      )
      .exec();
  }

  async unsubscribe(userId: string, workId: string, sourceId: string): Promise<void> {
    await this.watchModel.deleteOne({ userId, workId, sourceId }).exec();
  }

  async count(workId: string, sourceId: string): Promise<number> {
    return this.watchModel.countDocuments({ workId, sourceId }).exec();
  }

  async isSubscribed(userId: string, workId: string, sourceId: string): Promise<boolean> {
    const existing = await this.watchModel.findOne({ userId, workId, sourceId }).lean().exec();
    return !!existing;
  }

  async getSubscribersUserIds(workId: string, sourceId: string): Promise<string[]> {
    const subs = await this.watchModel.find({ workId, sourceId }).lean().exec();
    return subs.map((s) => s.userId);
  }
}

