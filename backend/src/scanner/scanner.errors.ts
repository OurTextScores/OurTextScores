export class ScannerProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly httpStatus?: number
  ) {
    super(message);
    this.name = 'ScannerProviderError';
  }
}

const RETRYABLE_SCANNER_ERROR_CODES = new Set([
  'provider_timeout',
  'provider_unavailable',
  'provider_http_408',
  'provider_http_429',
  'provider_budget_exhausted',
  'internal_worker_error'
]);

export function isRetryableScannerErrorCode(code?: string): boolean {
  return Boolean(
    code &&
      (RETRYABLE_SCANNER_ERROR_CODES.has(code) || /^provider_http_5\d\d$/.test(code))
  );
}
