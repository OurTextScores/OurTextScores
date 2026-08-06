import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { ScannerProviderError } from './scanner.errors';

export interface ScanPageResult {
  musicXml: Buffer;
  providerRevision: string;
  modelRevision: string;
}

@Injectable()
export class ScannerProviderService {
  constructor(private readonly config: ConfigService) {}

  get expectedRevision(): string {
    return this.config.get<string>('SCANNER_EXPECTED_HOMR_COMMIT', '').trim();
  }

  createIdempotencyKey(input: {
    inputSha256: string;
    pageNumber: number;
    detectTitle: boolean;
    generation: number;
  }): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          engine: 'homr',
          revision: this.expectedRevision,
          preprocessingRevision: 'ots-scanner-poppler-1920-v1',
          ...input
        })
      )
      .digest('hex');
  }

  async scanPage(input: {
    image: Buffer;
    filename: string;
    contentType: string;
    detectTitle: boolean;
    idempotencyKey: string;
  }): Promise<ScanPageResult> {
    if (this.config.get<string>('SCANNER_PROVIDER_KIND', 'modal') === 'fake') {
      return this.fakeResult(input.idempotencyKey, input.filename);
    }

    const providerUrl = this.config.get<string>('SCANNER_PROVIDER_URL', '').trim();
    if (!providerUrl) {
      throw new ScannerProviderError(
        'Scanner provider is not configured',
        'provider_not_configured',
        false
      );
    }

    const timeoutMs = Math.max(
      1_000,
      Number(this.config.get<string>('SCANNER_PROVIDER_TIMEOUT_MS', '600000'))
    );
    const body = new FormData();
    const imageBytes = new Uint8Array(input.image.length);
    imageBytes.set(input.image);
    body.set('page', new Blob([imageBytes], { type: input.contentType }), input.filename);
    body.set('detectTitle', String(input.detectTitle));

    const headers = new Headers({
      'Idempotency-Key': input.idempotencyKey,
      Accept: 'application/json'
    });
    const providerToken = this.config.get<string>('SCANNER_PROVIDER_TOKEN', '').trim();
    if (providerToken) headers.set('Authorization', `Bearer ${providerToken}`);
    const tokenId = this.config.get<string>('SCANNER_MODAL_TOKEN_ID', '').trim();
    const tokenSecret = this.config.get<string>('SCANNER_MODAL_TOKEN_SECRET', '').trim();
    if (tokenId && tokenSecret) {
      headers.set('Authorization', `Bearer ${tokenId}.${tokenSecret}`);
      headers.set('Modal-Key', tokenId);
      headers.set('Modal-Secret', tokenSecret);
    }

    let response: Response;
    try {
      response = await fetch(`${providerUrl.replace(/\/$/, '')}/v1/scan-page`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error: any) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new ScannerProviderError(
        timedOut ? 'Scanner provider timed out' : 'Scanner provider is unavailable',
        timedOut ? 'provider_timeout' : 'provider_unavailable',
        true
      );
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const retryable =
        response.status === 408 || response.status === 429 || response.status >= 500;
      throw new ScannerProviderError(
        this.safeHttpErrorMessage(response.status),
        `provider_http_${response.status}`,
        retryable,
        response.status
      );
    }

    let result: any;
    try {
      result = await response.json();
    } catch {
      throw new ScannerProviderError(
        'Scanner provider returned invalid JSON',
        'provider_invalid_response',
        false
      );
    }

    const providerRevision = String(result?.serviceRevision || result?.providerRevision || '');
    const modelRevision = String(result?.modelRevision || result?.homrRevision || '');
    const executionProvider = String(result?.executionProvider || '');
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
      musicXml = Buffer.from(String(result?.musicXmlBase64 || ''), 'base64');
    } catch {
      throw new ScannerProviderError(
        'Scanner provider returned invalid MusicXML',
        'invalid_musicxml',
        false
      );
    }
    const xmlText = musicXml.toString('utf8');
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
    if (
      (!xmlText.includes('<score-partwise') && !xmlText.includes('<score-timewise')) ||
      (!xmlText.includes('</score-partwise>') && !xmlText.includes('</score-timewise>')) ||
      !/<(score-part|part)\b/.test(xmlText) ||
      !/<measure\b/.test(xmlText) ||
      /<!ENTITY\b/i.test(xmlText)
    ) {
      throw new ScannerProviderError(
        'Scanner provider returned invalid MusicXML',
        'invalid_musicxml',
        false
      );
    }

    return { musicXml, providerRevision, modelRevision };
  }

  private safeHttpErrorMessage(status: number): string {
    if (status === 408 || status === 504) return 'Scanner provider timed out';
    if (status === 429) return 'Scanner provider capacity is temporarily unavailable';
    if (status === 400) return 'Scanner provider rejected the page request';
    if (status === 413) return 'Scanner page exceeds the provider size limit';
    if (status === 415) return 'Scanner provider does not support this page format';
    if (status === 422) return 'HOMR could not recognize a score on this page';
    if (status >= 500) return 'Scanner provider is temporarily unavailable';
    return `Scanner provider rejected the request (${status})`;
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
    return {
      providerRevision: 'local-fake',
      modelRevision: this.expectedRevision || 'local-fake',
      musicXml: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><work><work-title>${title}</work-title></work><part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><note><rest/><duration>4</duration><type>whole</type></note></measure></part></score-partwise>`,
        'utf8'
      )
    };
  }
}
