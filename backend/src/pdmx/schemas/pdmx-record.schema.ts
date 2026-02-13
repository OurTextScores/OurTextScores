import { HydratedDocument } from 'mongoose';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ _id: false })
class PdmxAssets {
  @Prop({ trim: true })
  dataJsonPath?: string;

  @Prop({ trim: true })
  metadataJsonPath?: string;

  @Prop({ trim: true })
  mxlPath?: string;

  @Prop({ trim: true })
  pdfPath?: string;

  @Prop({ trim: true })
  midPath?: string;
}

@Schema({ _id: false })
class PdmxSubsets {
  @Prop({ default: false, index: true })
  all!: boolean;

  @Prop({ default: false, index: true })
  rated!: boolean;

  @Prop({ default: false, index: true })
  deduplicated!: boolean;

  @Prop({ default: false, index: true })
  ratedDeduplicated!: boolean;

  @Prop({ default: false, index: true })
  noLicenseConflict!: boolean;

  @Prop({ default: false, index: true })
  allValid!: boolean;
}

@Schema({ _id: false })
class PdmxReview {
  @Prop({ trim: true, enum: ['unknown', 'acceptable', 'unacceptable'], default: 'unknown', index: true })
  qualityStatus!: 'unknown' | 'acceptable' | 'unacceptable';

  @Prop({ default: false, index: true })
  excludedFromSearch!: boolean;

  @Prop({ trim: true })
  reason?: string;

  @Prop({ trim: true })
  notes?: string;

  @Prop({ trim: true })
  updatedBy?: string;

  @Prop({ type: Date })
  updatedAt?: Date;
}

@Schema({ _id: false })
class PdmxImport {
  @Prop({ trim: true, enum: ['not_imported', 'importing', 'imported', 'failed'], default: 'not_imported', index: true })
  status!: 'not_imported' | 'importing' | 'imported' | 'failed';

  @Prop({ trim: true })
  importedWorkId?: string;

  @Prop({ trim: true })
  importedSourceId?: string;

  @Prop({ trim: true })
  importedRevisionId?: string;

  @Prop({ trim: true })
  importedProjectId?: string;

  @Prop({ trim: true })
  imslpUrl?: string;

  @Prop({ trim: true })
  error?: string;

  @Prop({ trim: true })
  updatedBy?: string;

  @Prop({ type: Date })
  updatedAt?: Date;
}

const PdmxAssetsSchema = SchemaFactory.createForClass(PdmxAssets);
const PdmxSubsetsSchema = SchemaFactory.createForClass(PdmxSubsets);
const PdmxReviewSchema = SchemaFactory.createForClass(PdmxReview);
const PdmxImportSchema = SchemaFactory.createForClass(PdmxImport);

@Schema({
  collection: 'pdmx_records',
  timestamps: true
})
export class PdmxRecord {
  @Prop({ required: true, unique: true, index: true, trim: true })
  pdmxId!: string;

  @Prop({ index: true })
  datasetRecordId?: number;

  @Prop({ trim: true, index: true })
  datasetVersion?: string;

  @Prop({ type: PdmxAssetsSchema, default: {} })
  assets!: PdmxAssets;

  @Prop({ trim: true, index: true })
  title?: string;

  @Prop({ trim: true, index: true })
  songName?: string;

  @Prop({ trim: true, index: true })
  artistName?: string;

  @Prop({ trim: true, index: true })
  composerName?: string;

  @Prop({ trim: true })
  publisher?: string;

  @Prop({ trim: true })
  subtitle?: string;

  @Prop({ trim: true })
  genres?: string;

  @Prop({ trim: true })
  groups?: string;

  @Prop({ trim: true })
  tags?: string;

  @Prop({ trim: true, index: true })
  license?: string;

  @Prop({ trim: true })
  licenseUrl?: string;

  @Prop({ default: false, index: true })
  licenseConflict!: boolean;

  @Prop()
  rating?: number;

  @Prop()
  nRatings?: number;

  @Prop()
  nViews?: number;

  @Prop()
  nFavorites?: number;

  @Prop()
  nNotes?: number;

  @Prop()
  nTracks?: number;

  @Prop()
  nLyrics?: number;

  @Prop()
  nTokens?: number;

  @Prop({ type: PdmxSubsetsSchema, default: {} })
  subsets!: PdmxSubsets;

  @Prop({ type: PdmxReviewSchema, default: { qualityStatus: 'unknown', excludedFromSearch: false } })
  review!: PdmxReview;

  @Prop({ type: PdmxImportSchema, default: { status: 'not_imported' } })
  import!: PdmxImport;
}

export type PdmxRecordDocument = HydratedDocument<PdmxRecord>;
export const PdmxRecordSchema = SchemaFactory.createForClass(PdmxRecord);

PdmxRecordSchema.index({ 'review.excludedFromSearch': 1, 'review.qualityStatus': 1 });
PdmxRecordSchema.index({ 'subsets.noLicenseConflict': 1, 'subsets.allValid': 1 });
PdmxRecordSchema.index({ title: 'text', songName: 'text', composerName: 'text', artistName: 'text' });
