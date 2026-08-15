import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import {
  DEFAULT_NOTIFICATION_EMAIL_CATEGORIES,
  type UserNotificationPreferences
} from '../notification-preferences';

@Schema({
  collection: 'users',
  timestamps: true
})
export class User {
  @Prop({ required: true, unique: true, trim: true, lowercase: true, index: true })
  email!: string;

  @Prop({ type: Date })
  emailVerifiedAt?: Date;

  @Prop({ trim: true })
  googleSub?: string;

  @Prop({ trim: true })
  displayName?: string;

  @Prop({ trim: true, unique: true, sparse: true, lowercase: true })
  username?: string;

  @Prop({ type: [String], default: ['user'] })
  roles!: string[];

  @Prop({
    trim: true,
    enum: ['active', 'suspended', 'terminated'],
    default: 'active',
    index: true
  })
  status!: 'active' | 'suspended' | 'terminated';

  @Prop({ required: true, min: 0, default: 0 })
  enforcementStrikes!: number;

  @Prop({ type: Date })
  lastEnforcementAt?: Date;

  @Prop({
    type: {
      watchPreference: {
        type: String,
        enum: ['immediate', 'daily', 'weekly'],
        default: 'immediate'
      },
      emailEnabled: { type: Boolean, default: true },
      emailCategories: {
        type: {
          comments: { type: Boolean, default: true },
          revisions: { type: Boolean, default: true },
          reviews: { type: Boolean, default: true },
          scanner: { type: Boolean, default: true },
          approvals: { type: Boolean, default: true }
        },
        _id: false,
        default: { ...DEFAULT_NOTIFICATION_EMAIL_CATEGORIES }
      }
    },
    _id: false,
    default: {
      watchPreference: 'immediate',
      emailEnabled: true,
      emailCategories: { ...DEFAULT_NOTIFICATION_EMAIL_CATEGORIES }
    }
  })
  notify?: UserNotificationPreferences;
}

export type UserDocument = HydratedDocument<User>;
export const UserSchema = SchemaFactory.createForClass(User);
