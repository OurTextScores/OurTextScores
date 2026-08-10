import { Injectable } from '@nestjs/common';
import { providerErrorFromCode, ScannerProviderError } from './scanner.errors';

export interface ScannerProviderConnection {
  url: string;
  kind: string;
  providerToken?: string;
  modalTokenId?: string;
  modalTokenSecret?: string;
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface ScannerProviderHttpRequest {
  connection: ScannerProviderConnection;
  path: string;
  headers?: HeadersInit;
  body: BodyInit;
  nonOkError?: {
    message: string;
    code: string;
    retryable: boolean;
  };
}

/** Authenticated, bounded JSON transport shared by all scanner engines. */
@Injectable()
export class ScannerProviderHttpService {
  async postJson<T = any>(request: ScannerProviderHttpRequest): Promise<T> {
    const connection = request.connection;
    if (!connection.url.trim()) {
      throw new ScannerProviderError(
        'Scanner provider is not configured',
        'provider_not_configured',
        false
      );
    }

    const headers = new Headers(request.headers);
    this.applyAuth(headers, connection);
    let response: Response;
    try {
      response = await fetch(
        `${connection.url.replace(/\/$/, '')}/${request.path.replace(/^\//, '')}`,
        {
          method: 'POST',
          headers,
          body: request.body,
          // Custom Modal credentials are not covered by Fetch's cross-origin
          // Authorization stripping, so redirects are never part of this contract.
          redirect: 'error',
          signal: AbortSignal.timeout(Math.max(1_000, connection.timeoutMs))
        }
      );
    } catch (error: any) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new ScannerProviderError(
        timedOut ? 'Scanner provider timed out' : 'Scanner provider is unavailable',
        timedOut ? 'provider_timeout' : 'provider_unavailable',
        true
      );
    }

    if (!response.ok) {
      if (request.nonOkError) {
        await response.body?.cancel().catch(() => undefined);
        throw new ScannerProviderError(
          request.nonOkError.message,
          request.nonOkError.code,
          request.nonOkError.retryable,
          response.status
        );
      }
      await this.throwProviderResponseError(response, connection.maxResponseBytes);
    }

    const raw = await this.readCapped(response, connection.maxResponseBytes);
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new ScannerProviderError(
        'Scanner provider returned invalid JSON',
        'provider_invalid_response',
        false
      );
    }
  }

  private applyAuth(headers: Headers, connection: ScannerProviderConnection): void {
    if (connection.providerToken) {
      headers.set('Authorization', `Bearer ${connection.providerToken}`);
    }
    if (connection.kind !== 'modal') return;
    if (connection.modalTokenId && connection.modalTokenSecret) {
      headers.set(
        'Authorization',
        `Bearer ${connection.modalTokenId}.${connection.modalTokenSecret}`
      );
      headers.set('Modal-Key', connection.modalTokenId);
      headers.set('Modal-Secret', connection.modalTokenSecret);
    }
  }

  private async throwProviderResponseError(response: Response, maxBytes: number): Promise<never> {
    const raw = await this.readCapped(response, maxBytes);
    let envelope: any;
    try {
      envelope = raw ? JSON.parse(raw) : undefined;
    } catch {
      envelope = undefined;
    }
    const classified = providerErrorFromCode(envelope?.error?.code);
    if (classified) throw classified;

    // Modal returns this plain-text response when a workspace budget disables
    // the app, rather than a structured provider error.
    if (/workspace\s+\S+\s+is disabled/i.test(raw)) {
      throw new ScannerProviderError(
        'Scanner monthly capacity has been reached',
        'provider_budget_exhausted',
        false
      );
    }

    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new ScannerProviderError(
      this.safeHttpErrorMessage(response.status),
      `provider_http_${response.status}`,
      retryable,
      response.status
    );
  }

  private async readCapped(response: Response, configuredMaxBytes: number): Promise<string> {
    const maxBytes = Math.max(1024, configuredMaxBytes);
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new ScannerProviderError(
        `Scanner provider response exceeds the ${maxBytes} byte limit`,
        'provider_response_too_large',
        false
      );
    }

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
    if (status === 422) return 'The scanner engine could not recognize a score on this page';
    if (status >= 500) return 'Scanner provider is temporarily unavailable';
    return `Scanner provider rejected the request (${status})`;
  }
}
