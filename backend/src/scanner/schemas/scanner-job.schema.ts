import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import type { ScannerEnginePlan, ScannerPageEngines } from '../scanner-dual-engine';

export type ScannerJobDocument = HydratedDocument<ScannerJob>;

export const SCANNER_JOB_STATUSES = [
  'queued',
  'preparing',
  'ready',
  'running',
  'rendering',
  'succeeded',
  'partial',
  'failed',
  'cancelled'
] as const;

export type ScannerJobStatus = (typeof SCANNER_JOB_STATUSES)[number];

export interface ScannerStorageLocator {
  bucket: string;
  objectKey: string;
  sizeBytes: number;
  contentType: string;
  checksumSha256: string;
  /** Versioned digest of the ordered effective-page inputs for a derivative. */
  inputSignature?: string;
}

/** Pixel identity of the exact, post-rotation raster supplied to an OMR engine. */
export interface ScannerRasterIdentity {
  checksumSha256: string;
  width: number;
  height: number;
}

/** Immutable stored input for recognition and later page-coordinate crops. */
export interface ScannerRecognitionRaster extends ScannerRasterIdentity {
  storage: ScannerStorageLocator;
}

export interface ScannerSourceInput {
  originalFilename: string;
  storage: ScannerStorageLocator;
}

/**
 * Design section 7.1: the exact engine identity behind a result. The HOMR
 * commit alone is not enough — the weights are versioned separately from it.
 */
export interface ScannerEngineProvenance {
  /** Immutable OurTextScores adapter/provider source revision. */
  providerSourceCommit?: string;
  /** Generic immutable model artifact identity, used by engines other than HOMR too. */
  modelArtifact?: string;
  modelArtifactSha256?: string;
  containerImageDigest?: string;
  converter?: string;
  converterVersion?: string;
  segmentationModel?: string;
  segmentationModelSha256?: string;
  transformerModel?: string;
  encoderModelSha256?: string;
  decoderModelSha256?: string;
  executionProvider?: string;
}

/**
 * A reviewer's merged reading of one page, and what it was made against.
 *
 * The merged score begins as one engine's reading and stops being a function of
 * its inputs the moment a decision or an edit lands on it — so it is the page's
 * own artifact, not a derivative, and `effectivePageMusicXml` prefers it over
 * everything else. What is recorded here is the provenance that entitles it to
 * that position: which engine it started from, and which readings it answers.
 */
/**
 * One bar-level decision the reviewer made, and what it cost.
 *
 * Kept on the merged score rather than in a parallel collection because it is
 * provenance for *this* document: it says which engine a passage came from,
 * bound to the exact readings it was chosen between. Phase E reads these as
 * training signal, which is why `repairs` is recorded — a bar whose slur the
 * system dropped is not quite a clean engine win, and the corpus should know.
 */
export interface ScannerMergedDecision {
  blockIndex: number;
  /** Pair-scoped part identity; required by new records, absent on retained legacy ones. */
  stablePartKey?: string;
  /** Binds the decision to both artifact revisions; see `scannerBlockContentSignature`. */
  contentSignature: string;
  /** The engine the passage was taken from; absent for a flag record. */
  engineId?: string;
  /** Measures of the merged document that this replaced. */
  measureIndexes: number[];
  /** Anything the splice changed beyond copying, reported at the time. */
  repairs?: Array<{ code: string; detail: string }>;
  /**
   * This took dynamics and lyrics only, leaving the notes alone.
   *
   * Recorded distinctly because phase E must not read "that engine was right
   * here" from a decision that moved a dynamic — the notes it sits over came
   * from somewhere else, and may have come from the engine that lost.
   */
  markingsOnly?: 'dynamics' | 'lyrics';
  /** Latest value wins, so clearing a flag is durable and auditable too. */
  flagged?: boolean;
  decidedAt: Date;
}

/** One hand-corrected merged bar, localized to the matched part when known. */
export interface ScannerMergedEditedMeasure {
  measureIndex: number;
  stablePartKey?: string;
}

export interface ScannerMergedScore {
  /** The engine whose reading the merge started from, wholesale. */
  sourceEngineId: string;
  /** `scannerMergedScoreBasis` of the readings this merge was built against. */
  basisSignature: string;
  /**
   * True once the reviewer has hand-corrected the merged score.
   *
   * Kept separate from the decision record because an edited bar is evidence
   * that *both* engines were wrong, and filing it as an engine win would poison
   * the corpus this feature exists to build.
   */
  edited?: boolean;
  /** Exact merged bars touched by hand; `edited` remains the legacy/page summary. */
  editedMeasures?: ScannerMergedEditedMeasure[];
  /** Saves of this merged score; increments on every accepted write. */
  revision: number;
  /** Bar-level takes, in the order they were made. */
  decisions?: ScannerMergedDecision[];
  /**
   * Which engine measure each merged bar corresponds to; see
   * `scanner-merged-measure-map.ts`.
   *
   * Absent means the two numberings still coincide, which is true until the
   * first insertion or deletion. Present, it is what lets a decision expressed
   * in engine measure indexes find the right bar of a merged score whose length
   * has changed.
   */
  measureMap?: Array<number | null>;
  /**
   * The same provenance map per matched part.
   *
   * `measureMap` predates multi-part decisions and remains the compatibility
   * projection for the first part (and for the row renderer's page-wide line
   * starts). A structural take in another part must not shift that first-part
   * map, so Phase D stores the authoritative maps by pair-scoped stable part
   * key here.
   */
  measureMaps?: Record<string, Array<number | null>>;
  updatedAt: Date;
}

export interface ScannerPageResult {
  pageNumber: number;
  ordinal: number;
  rotationDegrees: 0 | 90 | 180 | 270;
  included: boolean;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';
  /** Provider calls in the current generation; this is what the UI shows. */
  attempts: number;
  /** Provider calls across every generation and worker recovery (13.4). */
  providerAttempts?: number;
  idempotencyKey: string;
  manualRetries?: number;
  sourceImage?: ScannerStorageLocator;
  thumbnail?: ScannerStorageLocator;
  recognitionRaster?: ScannerRecognitionRaster;
  /** Superseded immutable rasters retained only so source expiry can delete them. */
  recognitionRasterHistory?: ScannerRecognitionRaster[];
  musicXml?: ScannerStorageLocator;
  /** MusicXML produced by dual-engine reconciliation; preferred over spot review. */
  mergedMusicXml?: ScannerStorageLocator;
  /** Provenance for `mergedMusicXml`; absent until a reviewer saves a merge. */
  mergedScore?: ScannerMergedScore;
  /** Phase 0 dual-engine state; legacy top-level HOMR fields remain during migration. */
  engines?: ScannerPageEngines;
  pdf?: ScannerStorageLocator;
  providerRequestId?: string;
  /** Wall-clock time of the provider call, including any cold-start wait. */
  durationMs?: number;
  /** Recognition time inside the provider, excluding cold start (11.3). */
  inferenceMs?: number;
  errorCode?: string;
  errorMessage?: string;
  /** Legacy HOMR projection; engine runs own reviewed artifacts. */
  reviewedMusicXml?: ScannerStorageLocator;
  /** Legacy HOMR projection; engine runs own their correction history. */
  corrections?: Array<{
    spotId: number;
    head: string;
    predicted: string;
    predictedConfidence: number;
    offered: Array<{ value: string; confidence: number }>;
    chosen: string;
    outcome: 'confirmed' | 'corrected';
    /** Engine content against which this decision was made. */
    contentSignature?: string;
    correctedAt: Date;
  }>;
  /**
   * Legacy HOMR projection of capability-owned raw review data.
   * Selection remains dynamic so thresholds can change without re-scanning.
   */
  review?: {
    staves: Array<{
      index: number;
      /** HOMR part/voice and physical system identity for safe regeneration. */
      partIndex?: number;
      systemIndex?: number;
      region?: number[] | null;
      /** The full decoded sequence; a correction edits this, not the XML. */
      tokens?: string[][];
      barLines?: number[];
      symbols: Array<{
        index: number;
        rhythm?: string;
        heads: Record<
          string,
          {
            chosen: string;
            confidence: number;
            alternatives: Array<{ value: string; confidence: number }>;
          }
        >;
        attention?: number[] | null;
      }>;
    }>;
  };
}

@Schema({ collection: 'scanner_jobs', timestamps: true })
export class ScannerJob {
  @Prop({ required: true, unique: true, index: true, trim: true })
  jobId!: string;

  @Prop({ required: true, index: true, trim: true })
  userId!: string;

  @Prop({ required: true, enum: SCANNER_JOB_STATUSES, index: true })
  status!: ScannerJobStatus;

  /**
   * Design section 7.1: incremented on every externally visible change, so a
   * client can tell a stale snapshot from a current one without diffing, and so
   * a later SSE stream has a resume token (section 8.6 `Last-Event-ID`).
   */
  @Prop({ required: true, default: 1 })
  statusVersion!: number;

  @Prop({ required: true, trim: true })
  originalFilename!: string;

  @Prop({ required: true, trim: true })
  inputContentType!: string;

  @Prop({ required: true, min: 1 })
  pageCount!: number;

  // `input` is retained for jobs created before multi-image uploads. New jobs
  // use `inputs`, and the worker reads either representation.
  @Prop({ type: Object })
  input?: ScannerStorageLocator;

  @Prop({ type: [Object], default: [] })
  inputs!: ScannerSourceInput[];

  @Prop({ type: Object, default: {} })
  options!: { detectTitle?: boolean };

  @Prop({ required: true, default: 1 })
  generation!: number;

  @Prop({ type: [Object], default: [] })
  pages!: ScannerPageResult[];

  /** Immutable engine selection and capability semantics for this job. */
  @Prop({ type: Object })
  enginePlan?: ScannerEnginePlan;

  @Prop({ type: [Number] })
  retryPageNumbers?: number[];

  @Prop({ type: Date })
  preparedAt?: Date;

  /**
   * Page images finished so far, while a source is still being rasterised.
   *
   * Preparation writes its pages in one transaction at the end, so until it
   * lands the job looks identical whether it is on page one of twenty or page
   * nineteen. This is the only signal a reader has that it is moving, and at
   * roughly five seconds a page that matters. Cleared when preparation ends.
   */
  @Prop({ type: Number })
  preparedPageCount?: number;

  /** Set when the job enters the provider queue; starts the queue-wait clock. */
  @Prop({ type: Date })
  queuedAt?: Date;

  @Prop({ type: Object })
  musicXmlBundle?: ScannerStorageLocator;

  /** Design section 6: validated whole-score assembly, or an honest reason. */
  @Prop({ type: Object })
  combinedMusicXml?: ScannerStorageLocator;

  /**
   * A correction invalidated the combined score that had already been built.
   * The per-page files stay correct; this stops a stale combined download from
   * being offered as though it included the reviewer's work.
   */
  @Prop({ type: Boolean })
  combinedStale?: boolean;

  @Prop({ type: Object })
  combinedPdf?: ScannerStorageLocator;

  @Prop({ type: String, default: 'not-requested' })
  mergeStatus!: 'not-requested' | 'succeeded' | 'incompatible' | 'failed';

  @Prop({ trim: true })
  mergeReason?: string;

  @Prop({ type: Object })
  resultsZip?: ScannerStorageLocator;

  @Prop({ type: Object })
  previewPdf?: ScannerStorageLocator;

  @Prop({ type: Object })
  previewThumbnail?: ScannerStorageLocator;

  @Prop({ trim: true })
  providerRevision?: string;

  @Prop({ trim: true })
  modelRevision?: string;

  @Prop({ type: Object })
  engineProvenance?: ScannerEngineProvenance;

  /**
   * Design section 13.4 durations, kept on the job so the Phase 0 benchmark can
   * be answered from the collection rather than by scraping logs.
   */
  @Prop({ type: Object, default: {} })
  timings!: {
    queueWaitMs?: number;
    prepareMs?: number;
    providerMs?: number;
    renderMs?: number;
    totalMs?: number;
  };

  @Prop({ trim: true })
  errorCode?: string;

  @Prop({ trim: true })
  errorMessage?: string;

  @Prop({ type: Date })
  startedAt?: Date;

  @Prop({ type: Date })
  completedAt?: Date;

  @Prop({ type: Date, index: true })
  leaseExpiresAt?: Date;

  @Prop({ trim: true })
  leaseOwner?: string;

  @Prop({ type: Date })
  terminalNotifiedAt?: Date;

  /**
   * A request to rebuild this job's derived artifacts from its current effective
   * pages.
   *
   * Assembly runs when scanning finishes, but review happens afterwards, so a
   * correction leaves the combined score and rendered previews describing pages
   * that no longer exist. Those are withheld rather than served stale, which is
   * safe but leaves the user with nothing. Rendered artifacts need MuseScore, so
   * only the worker can rebuild them; this flag is how the API asks.
   */
  @Prop({ type: Date, index: true })
  reassembleRequestedAt?: Date;

  @Prop({ type: Date })
  sourceDeletedAt?: Date;

  @Prop({ type: Date })
  resultsDeletedAt?: Date;

  @Prop({ type: Date, required: true, index: true })
  sourceExpiresAt!: Date;

  @Prop({ type: Date, required: true, index: true })
  resultExpiresAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export const ScannerJobSchema = SchemaFactory.createForClass(ScannerJob);

ScannerJobSchema.index({ userId: 1, createdAt: -1 });
ScannerJobSchema.index({ userId: 1, status: 1 });
ScannerJobSchema.index({ status: 1, leaseExpiresAt: 1, createdAt: 1 });
