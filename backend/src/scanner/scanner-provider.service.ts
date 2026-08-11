import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { ScannerProviderError } from './scanner.errors';
import { assertValidMusicXml } from './scanner-musicxml';
import type { ReviewStaff } from './scanner-review';
import {
  ScannerPageProvider,
  ScannerProviderResult,
  ScannerProviderScanInput,
  scannerProviderIdempotencyKey
} from './scanner-provider.contract';
import {
  ScannerProviderConnection,
  ScannerProviderHttpService
} from './scanner-provider-http.service';

export type ScanPageResult = ScannerProviderResult;
export type ScannerModelProvenance = ScannerProviderResult['provenance'];

@Injectable()
export class ScannerProviderService implements ScannerPageProvider {
  readonly engine = 'homr' as const;

  constructor(
    private readonly config: ConfigService,
    private readonly http: ScannerProviderHttpService = new ScannerProviderHttpService()
  ) {}

  get expectedRevision(): string {
    return this.config.get<string>('SCANNER_EXPECTED_HOMR_COMMIT', '').trim();
  }

  /**
   * Rebuild MusicXML from an edited token sequence.
   *
   * No inference, so no GPU time and no idempotency key: this is HOMR's own
   * generator over symbols we already hold. Correcting at token level rather
   * than re-recognising the page is what makes a correction free.
   */
  async regenerate(staffs: string[][][]): Promise<Buffer> {
    return this.regenerateReview(staffs);
  }

  async regenerateReview(staffs: string[][][]): Promise<Buffer> {
    const result = await this.http.postJson({
      connection: { ...this.connection(), timeoutMs: 60_000 },
      path: '/v1/regenerate',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ staffs }),
      nonOkError: {
        message: 'The corrected score could not be rebuilt',
        code: 'provider_generation_failed',
        retryable: false
      }
    });
    const musicXml = Buffer.from(String(result?.result?.musicXmlBase64 || ''), 'base64');
    // Held to the same bar as provider output: this becomes a stored artifact
    // and is offered for download, so it is validated, not trusted.
    this.assertValidMusicXml(musicXml);
    return musicXml;
  }

  createIdempotencyKey(input: {
    inputSha256: string;
    pageNumber: number;
    detectTitle: boolean;
    generation: number;
  }): string {
    return scannerProviderIdempotencyKey({
      engine: this.engine,
      modelRevision: this.expectedRevision,
      preprocessingRevision: 'ots-scanner-poppler-1920-v1',
      ...input
    });
  }

  async scanPage(input: ScannerProviderScanInput): Promise<ScanPageResult> {
    if (this.config.get<string>('SCANNER_PROVIDER_KIND', 'modal') === 'fake') {
      return this.fakeResult(input.idempotencyKey, input.filename);
    }

    const body = new FormData();
    const imageBytes = new Uint8Array(input.image.length);
    imageBytes.set(input.image);
    body.set('page', new Blob([imageBytes], { type: input.contentType }), input.filename);
    body.set('detectTitle', String(input.detectTitle));

    const result = await this.http.postJson({
      connection: this.connection(),
      path: '/v1/scan-page',
      headers: { 'Idempotency-Key': input.idempotencyKey, Accept: 'application/json' },
      body
    });

    // Prefer the `ots-homr-provider.v1` envelope, falling back to the flat
    // aliases so a provider deployed before that contract still works.
    const engine = (
      result?.engine && typeof result.engine === 'object' ? result.engine : {}
    ) as any;
    const providerRevision = String(
      engine.serviceRevision || result?.serviceRevision || result?.providerRevision || ''
    );
    const modelRevision = String(
      engine.homrCommit || result?.modelRevision || result?.homrRevision || ''
    );
    const executionProvider = String(engine.executionProvider || result?.executionProvider || '');
    const expectedInputSha256 = createHash('sha256').update(input.image).digest('hex');
    const receivedInputSha256 = String(result?.inputSha256 || '');
    if (receivedInputSha256 !== expectedInputSha256) {
      throw new ScannerProviderError(
        'Scanner provider input verification failed',
        'provider_input_digest_mismatch',
        false
      );
    }
    const expectedProviderRevision = this.config
      .get<string>('SCANNER_EXPECTED_PROVIDER_REVISION', 'ots-homr-modal-v1')
      .trim();
    if (expectedProviderRevision && providerRevision !== expectedProviderRevision) {
      throw new ScannerProviderError(
        'Scanner provider service verification failed',
        'provider_service_revision_mismatch',
        false
      );
    }
    if (this.expectedRevision && modelRevision !== this.expectedRevision) {
      throw new ScannerProviderError(
        'Scanner provider model verification failed',
        'provider_model_revision_mismatch',
        false
      );
    }
    const expectedExecutionProvider = this.config
      .get<string>('SCANNER_EXPECTED_EXECUTION_PROVIDER', 'CUDAExecutionProvider')
      .trim();
    if (expectedExecutionProvider && executionProvider !== expectedExecutionProvider) {
      throw new ScannerProviderError(
        'Scanner provider execution verification failed',
        'provider_execution_provider_mismatch',
        false
      );
    }

    let musicXml: Buffer;
    try {
      musicXml = Buffer.from(
        String(result?.musicXmlBase64 || result?.result?.musicXmlBase64 || ''),
        'base64'
      );
    } catch {
      throw new ScannerProviderError(
        'Scanner provider returned invalid MusicXML',
        'invalid_musicxml',
        false
      );
    }
    const maxMusicXmlBytes = Math.max(
      1024,
      Number(this.config.get<string>('SCANNER_MAX_MUSICXML_BYTES', '10485760'))
    );
    if (musicXml.length > maxMusicXmlBytes) {
      throw new ScannerProviderError(
        `Scanner provider MusicXML exceeds the ${maxMusicXmlBytes} byte limit`,
        'provider_response_too_large',
        false
      );
    }
    const musicXmlSha256 = createHash('sha256').update(musicXml).digest('hex');
    const declaredSha256 = String(result?.result?.sha256 || '');
    if (declaredSha256 && declaredSha256 !== musicXmlSha256) {
      throw new ScannerProviderError(
        'Scanner provider output verification failed',
        'provider_output_digest_mismatch',
        false
      );
    }
    this.assertValidMusicXml(musicXml);

    return {
      engine: this.engine,
      musicXml,
      providerRevision,
      modelRevision,
      musicXmlSha256,
      review: normaliseReview(result?.review),
      requestId: result?.requestId ? String(result.requestId) : undefined,
      inferenceMs: Number.isFinite(Number(result?.timing?.inferenceMs))
        ? Number(result.timing.inferenceMs)
        : undefined,
      provenance: {
        segmentationModel: this.text(engine.segmentationModel),
        segmentationModelSha256: this.text(engine.segmentationModelSha256),
        transformerModel: this.text(engine.transformerModel),
        encoderModelSha256: this.text(engine.encoderModelSha256),
        decoderModelSha256: this.text(engine.decoderModelSha256),
        executionProvider: this.text(executionProvider)
      }
    };
  }

  private assertValidMusicXml(musicXml: Buffer): void {
    assertValidMusicXml(musicXml, {
      maxNodes: this.number('SCANNER_MAX_MUSICXML_NODES', 500_000),
      maxDepth: this.number('SCANNER_MAX_MUSICXML_DEPTH', 100)
    });
  }

  private text(value: unknown): string | undefined {
    const result = typeof value === 'string' ? value.trim() : '';
    return result || undefined;
  }

  private number(key: string, fallback: number): number {
    const parsed = Number(this.config.get<string>(key, String(fallback)));
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  }

  private connection(): ScannerProviderConnection {
    return {
      url: this.config.get<string>('SCANNER_PROVIDER_URL', '').trim(),
      kind: this.config.get<string>('SCANNER_PROVIDER_KIND', 'modal').trim(),
      providerToken: this.config.get<string>('SCANNER_PROVIDER_TOKEN', '').trim() || undefined,
      modalTokenId: this.config.get<string>('SCANNER_MODAL_TOKEN_ID', '').trim() || undefined,
      modalTokenSecret:
        this.config.get<string>('SCANNER_MODAL_TOKEN_SECRET', '').trim() || undefined,
      timeoutMs: this.number('SCANNER_PROVIDER_TIMEOUT_MS', 600_000),
      maxResponseBytes: this.number('SCANNER_MAX_PROVIDER_RESPONSE_BYTES', 33_554_432)
    };
  }

  private fakeResult(key: string, filename: string): ScanPageResult {
    const pageNumber = Number(filename.match(/page-(\d+)/)?.[1] || 0);
    const generation = Number(filename.match(/generation-(\d+)/)?.[1] || 1);
    const failedPage = Number(this.config.get<string>('SCANNER_FAKE_TRANSIENT_FAILURE_PAGE', '0'));
    if (pageNumber > 0 && pageNumber === failedPage && generation === 1) {
      throw new ScannerProviderError(
        'Scanner test provider is temporarily unavailable',
        'provider_http_503',
        true,
        503
      );
    }
    const title = `Scanner test ${key.slice(0, 8)}`;
    const musicXml = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><work><work-title>${title}</work-title></work><part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><note><rest/><duration>4</duration><type>whole</type></note></measure></part></score-partwise>`,
      'utf8'
    );
    return {
      engine: this.engine,
      providerRevision: 'local-fake',
      modelRevision: this.expectedRevision || 'local-fake',
      musicXml,
      musicXmlSha256: createHash('sha256').update(musicXml).digest('hex'),
      requestId: key.slice(0, 16),
      inferenceMs: 1,
      provenance: {
        segmentationModel: 'local-fake-segnet',
        segmentationModelSha256: 'f'.repeat(64),
        transformerModel: 'local-fake-transformer',
        encoderModelSha256: 'e'.repeat(64),
        decoderModelSha256: 'd'.repeat(64),
        executionProvider: 'CPUExecutionProvider'
      }
    };
  }
}

/**
 * Coerce the provider's review block into the shape the rest of the backend
 * expects, dropping anything malformed.
 *
 * The provider is treated as untrusted here for the same reason as everywhere
 * else in this client: this data reaches a UI and is stored, so a hostile or
 * simply buggy provider must not be able to inject arbitrary structure. Numbers
 * are coerced, unknown keys are dropped, and a failure yields no review rather
 * than a partially-trusted one.
 */
function normaliseReview(raw: any): { staves: ReviewStaff[] } | undefined {
  const staves = raw?.staves;
  if (!Array.isArray(staves)) return undefined;
  const clean: ReviewStaff[] = [];
  for (const staff of staves) {
    const index = Number(staff?.index);
    if (!Number.isFinite(index)) continue;
    const region = Array.isArray(staff?.region)
      ? staff.region.slice(0, 4).map((value: unknown) => Number(value))
      : null;
    const symbols = Array.isArray(staff?.symbols) ? staff.symbols : [];
    clean.push({
      index,
      region: region && region.every((value: number) => Number.isFinite(value)) ? region : null,
      // Six string fields per symbol; a correction edits one and the provider
      // rebuilds MusicXML from the result.
      tokens: Array.isArray(staff?.tokens)
        ? staff.tokens
            .filter(
              (row: unknown) =>
                Array.isArray(row) && row.length === 6 && row.every((f) => typeof f === 'string')
            )
            .map((row: string[]) => [...row])
        : [],
      barLines: Array.isArray(staff?.barLines)
        ? staff.barLines.map((value: unknown) => Number(value)).filter(Number.isFinite)
        : [],
      symbols: symbols
        .map((symbol: any) => {
          const symbolIndex = Number(symbol?.index);
          if (!Number.isFinite(symbolIndex)) return null;
          const heads: Record<string, any> = {};
          for (const [name, entry] of Object.entries(symbol?.heads || {})) {
            const head = entry as any;
            const confidence = Number(head?.confidence);
            if (!head?.chosen || !Number.isFinite(confidence)) continue;
            heads[name] = {
              chosen: String(head.chosen),
              confidence,
              alternatives: (Array.isArray(head.alternatives) ? head.alternatives : [])
                .map((alternative: any) => ({
                  value: String(alternative?.value ?? ''),
                  confidence: Number(alternative?.confidence)
                }))
                .filter(
                  (alternative: any) => alternative.value && Number.isFinite(alternative.confidence)
                )
            };
          }
          if (Object.keys(heads).length === 0) return null;
          const attention = Array.isArray(symbol?.attention)
            ? symbol.attention.slice(0, 2).map((value: unknown) => Number(value))
            : null;
          return {
            index: symbolIndex,
            rhythm: symbol?.rhythm ? String(symbol.rhythm) : undefined,
            heads,
            attention:
              attention && attention.every((value: number) => Number.isFinite(value))
                ? attention
                : null
          };
        })
        .filter(Boolean) as any[]
    });
  }
  return { staves: clean };
}
