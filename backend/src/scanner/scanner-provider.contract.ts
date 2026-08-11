import { createHash } from 'node:crypto';
import type { ReviewStaff } from './scanner-review';
import type { ScannerEngineName, ScannerGenerationMetadata } from './scanner-dual-engine';
import type { ScannerEngineProvenance } from './schemas/scanner-job.schema';

export interface ScannerProviderScanInput {
  image: Buffer;
  filename: string;
  contentType: string;
  detectTitle: boolean;
  idempotencyKey: string;
}

export interface ScannerProviderResult {
  engine: ScannerEngineName;
  musicXml: Buffer;
  /** Model-authored kern retained before Transcoda's MusicXML conversion. */
  kern?: Buffer;
  providerRevision: string;
  modelRevision: string;
  provenance: ScannerEngineProvenance;
  requestId?: string;
  inferenceMs?: number;
  /** Decoder termination diagnostics; currently supplied by Transcoda. */
  generation?: ScannerGenerationMetadata;
  musicXmlSha256: string;
  /** HOMR-only review data; absent without decoded token geometry. */
  review?: { staves: ReviewStaff[] };
}

/** Engine adapter consumed by orchestration; transport details stay behind it. */
export interface ScannerPageProvider {
  readonly engine: ScannerEngineName;
  readonly expectedRevision: string;
  createIdempotencyKey(input: {
    inputSha256: string;
    pageNumber: number;
    detectTitle: boolean;
    generation: number;
  }): string;
  scanPage(input: ScannerProviderScanInput): Promise<ScannerProviderResult>;
}

export function scannerProviderIdempotencyKey(input: {
  engine: ScannerEngineName;
  modelRevision: string;
  modelArtifactSha256?: string;
  converterVersion?: string;
  preprocessingRevision: string;
  inputSha256: string;
  pageNumber: number;
  detectTitle: boolean;
  generation: number;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
