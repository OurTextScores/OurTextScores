import { Injectable } from '@nestjs/common';
import { ReviewStaff } from './scanner-review';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { providerErrorFromCode, ScannerProviderError } from './scanner.errors';
import { assertValidMusicXml } from './scanner-musicxml';

export interface ScannerModelProvenance {
  segmentationModel?: string;
  segmentationModelSha256?: string;
  transformerModel?: string;
  encoderModelSha256?: string;
  decoderModelSha256?: string;
  executionProvider?: string;
}

export interface ScanPageResult {
  musicXml: Buffer;
  providerRevision: string;
  modelRevision: string;
  provenance: ScannerModelProvenance;
  requestId?: string;
  /**
   * Recognition time as measured inside the provider. Design section 11.3
   * requires separating this from provider start and network time: on a cold
   * container the caller's wall clock is dominated by the readiness wait, so
   * using it as "recognition time" overstates it by an order of magnitude.
   */
  inferenceMs?: number;
  musicXmlSha256: string;
  /**
   * Provider v2 review data: staff geometry and, for the symbols the provider
   * did not prune, the model's own confidence and alternatives. Optional
   * because a v1 provider omits it and everything else must keep working.
   */
  review?: { staves: ReviewStaff[] };
}

@Injectable()
export class ScannerProviderService {
  constructor(private readonly config: ConfigService) {}

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
    const providerUrl = this.config.get<string>('SCANNER_PROVIDER_URL', '').trim();
    if (!providerUrl) {
      throw new ScannerProviderError(
        'Scanner provider is not configured',
        'provider_not_configured',
        false
      );
    }
    const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json' });
    this.applyProviderAuth(headers);

    let response: Response;
    try {
      response = await fetch(`${providerUrl.replace(/\/$/, '')}/v1/regenerate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ staffs }),
        redirect: 'error',
        signal: AbortSignal.timeout(60_000)
      });
    } catch {
      throw new ScannerProviderError(
        'Scanner provider is unavailable',
        'provider_unavailable',
        true
      );
    }
    if (!response.ok) {
      throw new ScannerProviderError(
        'The corrected score could not be rebuilt',
        'provider_generation_failed',
        false
      );
    }
    const result: any = await response.json();
    const musicXml = Buffer.from(String(result?.result?.musicXmlBase64 || ''), 'base64');
    // Held to the same bar as provider output: this becomes a stored artifact
    // and is offered for download, so it is validated, not trusted.
    this.assertValidMusicXml(musicXml);
    return musicXml;
  }


  /**
   * Attach the credentials the configured provider expects.
   *
   * Gated on `SCANNER_PROVIDER_KIND`, because Modal credentials commonly sit in
   * an environment that is also used to run the local CPU provider. Applying
   * them unconditionally overwrote the local bearer token and the provider
   * answered 401 — a confusing failure, since the local token was set correctly
   * and the request looked authenticated from the caller's side.
   */
  private applyProviderAuth(headers: Headers): void {
    const providerToken = this.config.get<string>('SCANNER_PROVIDER_TOKEN', '').trim();
    if (providerToken) headers.set('Authorization', `Bearer ${providerToken}`);

    if (this.config.get<string>('SCANNER_PROVIDER_KIND', 'modal') !== 'modal') return;
    const tokenId = this.config.get<string>('SCANNER_MODAL_TOKEN_ID', '').trim();
    const tokenSecret = this.config.get<string>('SCANNER_MODAL_TOKEN_SECRET', '').trim();
    if (tokenId && tokenSecret) {
      headers.set('Authorization', `Bearer ${tokenId}.${tokenSecret}`);
      headers.set('Modal-Key', tokenId);
      headers.set('Modal-Secret', tokenSecret);
    }
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
    this.applyProviderAuth(headers);

    let response: Response;
    try {
      response = await fetch(`${providerUrl.replace(/\/$/, '')}/v1/scan-page`, {
        method: 'POST',
        headers,
        body,
        // The provider contract has no redirect. Following one would forward
        // `Modal-Key` and `Modal-Secret` to the target: the Fetch standard
        // strips `Authorization` on a cross-origin redirect but says nothing
        // about custom headers, so a compromised or misconfigured provider
        // could hand our credentials to a third party.
        redirect: 'error',
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
      const raw = await response.text().catch(() => '');
      let envelope: any;
      try {
        envelope = raw ? JSON.parse(raw) : undefined;
      } catch {
        envelope = undefined;
      }
      // The provider's stable code is more precise than the status, so prefer
      // it when the response carries one (design section 9.4).
      const classified = providerErrorFromCode(envelope?.error?.code);
      if (classified) throw classified;
      // Modal enforces a workspace budget by disabling the whole workspace, and
      // answers with a plain-text `404 modal-http: workspace … is disabled`.
      // Verified 2026-08-08 by running a $0.25 cap to exhaustion. Without this
      // the page fails as "rejected the request (404)", and because 404 is not
      // in the retryable set it could not be retried even after the operator
      // raised the budget — design §13.1 wants capacity exhaustion to stop
      // provider retries but stay recoverable by hand.
      if (/workspace\s+\S+\s+is disabled/i.test(raw)) {
        throw new ScannerProviderError(
          'Scanner monthly capacity has been reached',
          'provider_budget_exhausted',
          // Not auto-retryable: capacity is gone until an operator acts. The
          // code is in the manual-retry set, so the page can be retried after.
          false
        );
      }
      const retryable =
        response.status === 408 || response.status === 429 || response.status >= 500;
      throw new ScannerProviderError(
        this.safeHttpErrorMessage(response.status),
        `provider_http_${response.status}`,
        retryable,
        response.status
      );
    }

    // Bound the body before reading it. Every other check here treats the
    // provider as untrusted, but `response.json()` buffers whatever arrives:
    // the MusicXML ceiling below is applied to the decoded document, long after
    // an oversized body would already be in memory.
    const maxResponseBytes = Math.max(
      1024,
      Number(this.config.get<string>('SCANNER_MAX_PROVIDER_RESPONSE_BYTES', '33554432'))
    );
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
      throw new ScannerProviderError(
        `Scanner provider response exceeds the ${maxResponseBytes} byte limit`,
        'provider_response_too_large',
        false
      );
    }

    let result: any;
    try {
      // A chunked response declares no length, so cap the read itself.
      result = JSON.parse(await this.readCapped(response, maxResponseBytes));
    } catch (error) {
      if (error instanceof ScannerProviderError) throw error;
      throw new ScannerProviderError(
        'Scanner provider returned invalid JSON',
        'provider_invalid_response',
        false
      );
    }

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

  /**
   * Read a response body as text, aborting once it exceeds `maxBytes`.
   *
   * `response.text()` and `response.json()` buffer the whole body first, so a
   * provider that declares no `Content-Length` — every chunked response — could
   * exhaust memory before any ceiling applied. Counting bytes as they arrive
   * bounds it whether or not the length was declared.
   */
  private async readCapped(response: Response, maxBytes: number): Promise<string> {
    const body = response.body;
    if (!body) return '';
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          throw new ScannerProviderError(
            `Scanner provider response exceeds the ${maxBytes} byte limit`,
            'provider_response_too_large',
            false
          );
        }
        chunks.push(value);
      }
    } finally {
      // Release the connection whether we finished or bailed out early.
      await reader.cancel().catch(() => undefined);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
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
    const musicXml = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><work><work-title>${title}</work-title></work><part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><note><rest/><duration>4</duration><type>whole</type></note></measure></part></score-partwise>`,
      'utf8'
    );
    return {
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
                  (alternative: any) =>
                    alternative.value && Number.isFinite(alternative.confidence)
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
