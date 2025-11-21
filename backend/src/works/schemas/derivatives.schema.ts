import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { StorageLocator, StorageLocatorSchema } from './storage-locator.schema';

@Schema({ _id: false })
export class DerivativeArtifacts {
  @Prop({ type: StorageLocatorSchema })
  normalizedMxl?: StorageLocator;

  @Prop({ type: StorageLocatorSchema })
  canonicalXml?: StorageLocator;

  @Prop({ type: StorageLocatorSchema })
  linearizedXml?: StorageLocator;

  @Prop({ type: StorageLocatorSchema })
  pdf?: StorageLocator;

  @Prop({ type: StorageLocatorSchema })
  mscz?: StorageLocator;

  @Prop({ type: StorageLocatorSchema })
  manifest?: StorageLocator;

  @Prop({ type: StorageLocatorSchema })
  musicDiffReport?: StorageLocator;

  @Prop({ type: StorageLocatorSchema })
  musicDiffHtml?: StorageLocator;

  @Prop({ type: StorageLocatorSchema })
  musicDiffPdf?: StorageLocator;

  @Prop({ type: StorageLocatorSchema })
  thumbnail?: StorageLocator;
}

export const DerivativeArtifactsSchema = SchemaFactory.createForClass(DerivativeArtifacts);
