import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ collection: 'upload_operations', versionKey: false })
export class UploadOperation {
  @Prop({ required: true }) attemptId!: string;
  @Prop({ required: true }) observation!: 'backend' | 'client';
  @Prop({ required: true }) operation!: string;
  @Prop({ required: true }) status!: number;
  @Prop({ required: true }) outcome!: string;
  @Prop({ required: true }) category!: string;
  @Prop({ required: true }) durationMs!: number;
  @Prop() sizeBytes?: number;
  @Prop() userId?: string;
  @Prop() role?: string;
  @Prop() requestId?: string;
  @Prop() resetAt?: Date;
  @Prop({ required: true }) at!: Date;
}
export const UploadOperationSchema = SchemaFactory.createForClass(UploadOperation);
UploadOperationSchema.index({ attemptId: 1, observation: 1, userId: 1 }, { unique: true });
UploadOperationSchema.index({ at: 1 }, { expireAfterSeconds: 30 * 86400 });

@Schema({ collection: 'upload_limit_audit', versionKey: false })
export class UploadLimitAudit {
  @Prop({ required: true }) actorId!: string;
  @Prop({ required: true }) userId!: string;
  @Prop({ required: true }) action!: 'reset' | 'grant' | 'revoke';
  @Prop({ required: true }) reason!: string;
  @Prop() limit?: number;
  @Prop() expiresAt?: Date;
  @Prop({ required: true }) at!: Date;
}
export const UploadLimitAuditSchema = SchemaFactory.createForClass(UploadLimitAudit);
UploadLimitAuditSchema.index({ userId: 1, at: -1, _id: -1 });
