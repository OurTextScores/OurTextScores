import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { ScannerProviderError } from './scanner.errors';
import { assertValidMusicXml } from './scanner-musicxml';
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

/** Strict adapter for the Transcoda provider envelope; orchestration comes in Phase B. */
@Injectable()
export class ScannerTranscodaProviderService implements ScannerPageProvider {
  readonly engine = 'transcoda' as const;

  constructor(
    private readonly config: ConfigService,
    private readonly http: ScannerProviderHttpService = new ScannerProviderHttpService()
  ) {}

  get expectedRevision(): string {
    return this.config.get<string>('SCANNER_EXPECTED_TRANSCODA_MODEL_REVISION', '').trim();
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
      modelArtifactSha256: this.config
        .get<string>('SCANNER_EXPECTED_TRANSCODA_MODEL_SHA256', '')
        .trim(),
      converterVersion: this.config
        .get<string>('SCANNER_EXPECTED_TRANSCODA_CONVERTER_VERSION', '')
        .trim(),
      preprocessingRevision: 'ots-transcoda-1485x1050-v1',
      ...input
    });
  }

  async scanPage(input: ScannerProviderScanInput): Promise<ScannerProviderResult> {
    this.assertPinnedConfiguration();
    const body = new FormData();
    const imageBytes = new Uint8Array(input.image.length);
    imageBytes.set(input.image);
    body.set('page', new Blob([imageBytes], { type: input.contentType }), input.filename);

    const envelope: any = await this.http.postJson({
      connection: this.connection(),
      path: '/v1/scan-page',
      headers: { 'Idempotency-Key': input.idempotencyKey, Accept: 'application/json' },
      body
    });

    if (envelope?.schemaVersion !== 'ots-transcoda-provider.v1') {
      throw this.invalidResponse('Scanner Transcoda provider contract verification failed');
    }
    const engine = envelope?.engine;
    if (!engine || engine.name !== 'transcoda') {
      throw this.invalidResponse('Scanner Transcoda engine verification failed');
    }

    const providerRevision = this.requiredText(engine.serviceRevision);
    const modelRevision = this.requiredText(engine.modelRevision);
    const modelArtifact = this.requiredText(engine.modelArtifact);
    const modelArtifactSha256 = this.requiredSha256(engine.modelArtifactSha256);
    const containerImageDigest = this.requiredContainerDigest(engine.containerImageDigest);
    const converter = this.requiredText(engine.converter);
    const converterVersion = this.requiredText(engine.converterVersion);
    const executionProvider = this.requiredText(engine.executionProvider);

    this.verifyExpected(
      providerRevision,
      this.config.get<string>(
        'SCANNER_EXPECTED_TRANSCODA_PROVIDER_REVISION',
        'ots-transcoda-modal-v1'
      ),
      'provider_service_revision_mismatch',
      'Scanner Transcoda service verification failed'
    );
    this.verifyExpected(
      modelRevision,
      this.expectedRevision,
      'provider_model_revision_mismatch',
      'Scanner Transcoda model verification failed'
    );
    this.verifyExpected(
      modelArtifact,
      this.config.get<string>('SCANNER_EXPECTED_TRANSCODA_MODEL_ARTIFACT', ''),
      'provider_model_artifact_mismatch',
      'Scanner Transcoda model artifact verification failed'
    );
    this.verifyExpected(
      modelArtifactSha256,
      this.config.get<string>('SCANNER_EXPECTED_TRANSCODA_MODEL_SHA256', ''),
      'provider_model_artifact_mismatch',
      'Scanner Transcoda model artifact verification failed'
    );
    this.verifyExpected(
      containerImageDigest,
      this.config.get<string>('SCANNER_EXPECTED_TRANSCODA_CONTAINER_IMAGE_DIGEST', ''),
      'provider_container_image_mismatch',
      'Scanner Transcoda container verification failed'
    );
    this.verifyExpected(
      converter,
      this.config.get<string>('SCANNER_EXPECTED_TRANSCODA_CONVERTER', 'music21'),
      'provider_converter_mismatch',
      'Scanner Transcoda converter verification failed'
    );
    this.verifyExpected(
      converterVersion,
      this.config.get<string>('SCANNER_EXPECTED_TRANSCODA_CONVERTER_VERSION', ''),
      'provider_converter_mismatch',
      'Scanner Transcoda converter verification failed'
    );
    this.verifyExpected(
      executionProvider,
      this.config.get<string>(
        'SCANNER_EXPECTED_TRANSCODA_EXECUTION_PROVIDER',
        'CUDAExecutionProvider'
      ),
      'provider_execution_provider_mismatch',
      'Scanner Transcoda execution verification failed'
    );

    const expectedInputSha256 = createHash('sha256').update(input.image).digest('hex');
    if (this.requiredSha256(envelope.inputSha256) !== expectedInputSha256) {
      throw new ScannerProviderError(
        'Scanner provider input verification failed',
        'provider_input_digest_mismatch',
        false
      );
    }

    const kern = this.decodeBase64(envelope?.result?.kernBase64, 'kern');
    const musicXml = this.decodeBase64(envelope?.result?.musicXmlBase64, 'MusicXML');
    this.verifyOutputDigest(kern, envelope?.result?.kernSha256, 'kern');
    const musicXmlSha256 = this.verifyOutputDigest(
      musicXml,
      envelope?.result?.musicXmlSha256,
      'MusicXML'
    );
    this.assertValidKern(kern);
    this.assertValidMusicXml(musicXml);

    return {
      engine: this.engine,
      kern,
      musicXml,
      musicXmlSha256,
      providerRevision,
      modelRevision,
      requestId: this.optionalText(envelope.requestId),
      inferenceMs: Number.isFinite(Number(envelope?.timing?.inferenceMs))
        ? Number(envelope.timing.inferenceMs)
        : undefined,
      provenance: {
        modelArtifact,
        modelArtifactSha256,
        containerImageDigest,
        converter,
        converterVersion,
        executionProvider
      }
    };
  }

  private connection(): ScannerProviderConnection {
    return {
      url: this.config.get<string>('SCANNER_TRANSCODA_PROVIDER_URL', '').trim(),
      kind: this.config.get<string>('SCANNER_TRANSCODA_PROVIDER_KIND', 'modal').trim(),
      providerToken:
        this.config.get<string>('SCANNER_TRANSCODA_PROVIDER_TOKEN', '').trim() || undefined,
      modalTokenId:
        this.config.get<string>('SCANNER_TRANSCODA_MODAL_TOKEN_ID', '').trim() ||
        this.config.get<string>('SCANNER_MODAL_TOKEN_ID', '').trim() ||
        undefined,
      modalTokenSecret:
        this.config.get<string>('SCANNER_TRANSCODA_MODAL_TOKEN_SECRET', '').trim() ||
        this.config.get<string>('SCANNER_MODAL_TOKEN_SECRET', '').trim() ||
        undefined,
      timeoutMs: this.number('SCANNER_TRANSCODA_PROVIDER_TIMEOUT_MS', 600_000),
      maxResponseBytes: this.number('SCANNER_TRANSCODA_MAX_PROVIDER_RESPONSE_BYTES', 33_554_432)
    };
  }

  private assertPinnedConfiguration(): void {
    for (const key of [
      'SCANNER_EXPECTED_TRANSCODA_MODEL_ARTIFACT',
      'SCANNER_EXPECTED_TRANSCODA_MODEL_REVISION',
      'SCANNER_EXPECTED_TRANSCODA_MODEL_SHA256',
      'SCANNER_EXPECTED_TRANSCODA_CONTAINER_IMAGE_DIGEST',
      'SCANNER_EXPECTED_TRANSCODA_CONVERTER_VERSION'
    ]) {
      if (!this.config.get<string>(key, '').trim()) {
        throw new ScannerProviderError(
          'Scanner Transcoda provenance pins are not configured',
          'provider_not_configured',
          false
        );
      }
    }
    const modelSha256 = this.config
      .get<string>('SCANNER_EXPECTED_TRANSCODA_MODEL_SHA256', '')
      .trim()
      .toLowerCase();
    const containerDigest = this.config
      .get<string>('SCANNER_EXPECTED_TRANSCODA_CONTAINER_IMAGE_DIGEST', '')
      .trim()
      .toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(modelSha256) || !/^sha256:[a-f0-9]{64}$/.test(containerDigest)) {
      throw new ScannerProviderError(
        'Scanner Transcoda provenance pins are invalid',
        'provider_not_configured',
        false
      );
    }
  }

  private assertValidKern(kern: Buffer): void {
    const maxBytes = this.number('SCANNER_MAX_KERN_BYTES', 10_485_760);
    if (kern.length === 0 || kern.length > maxBytes) {
      throw new ScannerProviderError(
        kern.length > maxBytes
          ? `Scanner provider kern exceeds the ${maxBytes} byte limit`
          : 'Scanner provider returned invalid kern',
        kern.length > maxBytes ? 'provider_response_too_large' : 'provider_invalid_kern',
        false
      );
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(kern);
    } catch {
      throw new ScannerProviderError(
        'Scanner provider returned invalid kern',
        'provider_invalid_kern',
        false
      );
    }
    if (text.includes('\0')) {
      throw new ScannerProviderError(
        'Scanner provider returned invalid kern',
        'provider_invalid_kern',
        false
      );
    }
    const records = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('!!'));
    const interpretation = records.find((line) => line.startsWith('**'));
    const terminator = [...records].reverse().find((line) => line.startsWith('*'));
    if (
      !interpretation?.split('\t').includes('**kern') ||
      !terminator ||
      !terminator.split('\t').every((token) => token === '*-')
    ) {
      throw new ScannerProviderError(
        'Scanner provider returned invalid kern',
        'provider_invalid_kern',
        false
      );
    }
  }

  private assertValidMusicXml(musicXml: Buffer): void {
    const maxBytes = this.number('SCANNER_MAX_MUSICXML_BYTES', 10_485_760);
    if (musicXml.length > maxBytes) {
      throw new ScannerProviderError(
        `Scanner provider MusicXML exceeds the ${maxBytes} byte limit`,
        'provider_response_too_large',
        false
      );
    }
    assertValidMusicXml(musicXml, {
      maxNodes: this.number('SCANNER_MAX_MUSICXML_NODES', 500_000),
      maxDepth: this.number('SCANNER_MAX_MUSICXML_DEPTH', 100)
    });
  }

  private decodeBase64(value: unknown, label: string): Buffer {
    const encoded = this.requiredText(value);
    if (
      encoded.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    ) {
      throw this.invalidResponse(`Scanner provider returned invalid ${label}`);
    }
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.length === 0)
      throw this.invalidResponse(`Scanner provider returned invalid ${label}`);
    return decoded;
  }

  private verifyOutputDigest(buffer: Buffer, declared: unknown, label: string): string {
    const actual = createHash('sha256').update(buffer).digest('hex');
    if (this.requiredSha256(declared) !== actual) {
      throw new ScannerProviderError(
        `Scanner provider ${label} verification failed`,
        'provider_output_digest_mismatch',
        false
      );
    }
    return actual;
  }

  private verifyExpected(
    actual: string,
    configuredExpected: string,
    code: string,
    message: string
  ): void {
    const expected = configuredExpected.trim();
    if (expected && actual !== expected) {
      throw new ScannerProviderError(message, code, false);
    }
  }

  private requiredText(value: unknown): string {
    const text = this.optionalText(value);
    if (!text) throw this.invalidResponse('Scanner provider returned incomplete provenance');
    return text;
  }

  private requiredSha256(value: unknown): string {
    const text = this.requiredText(value).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(text)) {
      throw this.invalidResponse('Scanner provider returned invalid provenance digest');
    }
    return text;
  }

  private requiredContainerDigest(value: unknown): string {
    const text = this.requiredText(value).toLowerCase();
    if (!/^sha256:[a-f0-9]{64}$/.test(text)) {
      throw this.invalidResponse('Scanner provider returned invalid container digest');
    }
    return text;
  }

  private optionalText(value: unknown): string | undefined {
    const text = typeof value === 'string' ? value.trim() : '';
    return text || undefined;
  }

  private invalidResponse(message: string): ScannerProviderError {
    return new ScannerProviderError(message, 'provider_invalid_response', false);
  }

  private number(key: string, fallback: number): number {
    const parsed = Number(this.config.get<string>(key, String(fallback)));
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  }
}
