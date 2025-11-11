import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from './schemas/user.schema';

export interface BasicUserInfo {
  id: string;
  email: string;
  displayName?: string;
  roles: string[];
}

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>
  ) {}

  async findById(id: string): Promise<UserDocument | null> {
    return this.userModel.findById(id).exec();
  }

  async findByEmail(email: string): Promise<UserDocument | null> {
    const normalized = (email || '').trim().toLowerCase();
    if (!normalized) return null;
    return this.userModel.findOne({ email: normalized }).exec();
  }

  async findByUsername(username: string): Promise<UserDocument | null> {
    const normalized = (username || '').trim().toLowerCase();
    if (!normalized) return null;
    return this.userModel.findOne({ username: normalized }).exec();
  }

  async getOrCreateByEmail(email: string, displayName?: string): Promise<UserDocument> {
    const normalized = (email || '').trim().toLowerCase();
    return this.userModel
      .findOneAndUpdate(
        { email: normalized },
        {
          $setOnInsert: {
            email: normalized,
            displayName: displayName || undefined,
            roles: ['user']
          }
        },
        { new: true, upsert: true }
      )
      .exec();
  }

  toBasic(user: Pick<User, 'email' | 'displayName' | 'roles'> & { _id: any }): BasicUserInfo {
    return {
      id: String((user as any)._id),
      email: user.email,
      displayName: user.displayName ?? undefined,
      roles: Array.isArray(user.roles) ? user.roles : []
    };
  }
}

