import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

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
    type: {
      watchPreference: { type: String, enum: ['immediate', 'daily', 'weekly'], default: 'immediate' }
    },
    _id: false,
    default: { watchPreference: 'immediate' }
  })
  notify?: {
    watchPreference?: 'immediate' | 'daily' | 'weekly';
  };
}

export type UserDocument = HydratedDocument<User>;
export const UserSchema = SchemaFactory.createForClass(User);
UserSchema.index({ email: 1 }, { unique: true });
