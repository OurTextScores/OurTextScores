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

/**
 * Design section 9.4. The provider returns a stable code alongside the HTTP
 * status; the code is more precise, so it wins where both are present. The
 * user-facing text is chosen here rather than taken from the response, so a
 * compromised or misconfigured provider cannot put arbitrary text in the UI.
 */
const PROVIDER_ERROR_CODES: Record<string, { message: string; retryable: boolean }> = {
  no_staff_detected: {
    message: 'No staff lines were detected on this page',
    retryable: false
  },
  invalid_image: { message: 'This page image could not be read', retryable: false },
  invalid_media_type: {
    message: 'The scanner provider does not support this page format',
    retryable: false
  },
  image_too_large: { message: 'This page exceeds the provider size limit', retryable: false },
  invalid_option: { message: 'The scanner provider rejected this request', retryable: false },
  busy: { message: 'Scanner provider capacity is temporarily unavailable', retryable: true },
  model_not_ready: { message: 'The scanner provider is starting up', retryable: true },
  inference_timeout: { message: 'The scanner timed out on this page', retryable: true },
  inference_failed: { message: 'The scanner could not process this page', retryable: true },
  // Recognition succeeded; converting the result to MusicXML hit an invariant.
  // Deterministic, so never retried: the same page trips the same assert every
  // time and a retry would spend a second GPU call to fail identically.
  generation_failed: {
    message: 'The scanner recognised this page but could not build a score from it',
    retryable: false
  },
  generation_runaway: {
    message: 'The scanner produced a degenerate repeated sequence for this page',
    retryable: false
  }
};

export function providerErrorFromCode(code: unknown): ScannerProviderError | undefined {
  const known = typeof code === 'string' ? PROVIDER_ERROR_CODES[code] : undefined;
  return known
    ? new ScannerProviderError(known.message, `provider_${code}`, known.retryable)
    : undefined;
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
  if (!code) return false;
  const taxonomy = PROVIDER_ERROR_CODES[code.replace(/^provider_/, '')];
  if (taxonomy) return taxonomy.retryable;
  return RETRYABLE_SCANNER_ERROR_CODES.has(code) || /^provider_http_5\d\d$/.test(code);
}
