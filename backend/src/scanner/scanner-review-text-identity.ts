import { createHash } from 'node:crypto';

export const REVIEW_TEXT_IDENTITY_SCHEMA = 'ots.review-text-identity.v1';

/**
 * JSON with sorted keys, no whitespace and non-ASCII escaped: byte-for-byte what the provider's
 * `review_identity.canonical_json` produces, so both sides hash the same text.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value).replace(
      /[\u007f-\uffff]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
    );
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${canonicalJson(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

/** The digest of an identity's details, ignoring its own `sha256` field. */
export function reviewTextIdentitySha256(identity: Record<string, unknown>): string {
  const body = Object.fromEntries(Object.entries(identity).filter(([key]) => key !== 'sha256'));
  return createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
}

/** A review-text identity whose reported details give exactly the digest it claims. */
export function reviewTextIdentityConsistent(
  value: unknown
): value is Record<string, any> & { sha256: string } {
  const identity = value as Record<string, any> | undefined;
  return (
    !!identity &&
    typeof identity === 'object' &&
    identity.schemaVersion === REVIEW_TEXT_IDENTITY_SCHEMA &&
    typeof identity.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(identity.sha256) &&
    !!identity.ocr &&
    !!identity.semanticGate &&
    !!identity.dynamicsClassifier &&
    !!identity.codeSha256 &&
    reviewTextIdentitySha256(identity) === identity.sha256
  );
}
