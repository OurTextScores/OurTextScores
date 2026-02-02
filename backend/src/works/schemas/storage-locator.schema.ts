import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Checksum, ChecksumSchema } from './checksum.schema';

@Schema({ _id: false })
export class StorageLocator {
  @Prop({ required: true, trim: true })
  bucket!: string;

  @Prop({ required: true, trim: true })
  objectKey!: string;

  @Prop({ required: true, min: 0 })
  sizeBytes!: number;

  @Prop({ type: ChecksumSchema, required: true })
  checksum!: Checksum;

  @Prop({ required: true, trim: true })
  contentType!: string;

  @Prop({ type: Date, required: true })
  lastModifiedAt!: Date;

  @Prop({ type: Object })
  metadata?: {
    imslpSource?: {
      name: string;
      title: string;
      url: string;
      sha1: string;
      size: number;
      timestamp: string;
      user: string;
    };
  };
}

export const StorageLocatorSchema = SchemaFactory.createForClass(StorageLocator);
