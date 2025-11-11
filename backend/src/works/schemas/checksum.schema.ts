import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ _id: false })
export class Checksum {
  @Prop({ required: true, trim: true })
  algorithm!: string;

  @Prop({ required: true, trim: true })
  hexDigest!: string;
}

export const ChecksumSchema = SchemaFactory.createForClass(Checksum);
