import {
  canonicalJson,
  reviewTextIdentityConsistent,
  reviewTextIdentitySha256
} from './scanner-review-text-identity';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'scanner-review-text-identity.fixture.json'), 'utf8')
) as Record<string, any> & { sha256: string };

describe('review-text identity', () => {
  it('canonicalises like the provider: sorted keys, no whitespace, ASCII only', () => {
    expect(canonicalJson({ b: 1, a: { y: [2, 1], x: 0.5 } })).toBe(
      '{"a":{"x":0.5,"y":[2,1]},"b":1}'
    );
    expect(canonicalJson({ t: 'café' })).toBe('{"t":"caf\\u00e9"}');
  });

  it("recomputes the digest the provider's own code reported for a real identity", () => {
    // The fixture is the output of the provider's review_identity.py, hashed there with Python.
    expect(reviewTextIdentitySha256(fixture as Record<string, unknown>)).toBe(fixture.sha256);
    expect(reviewTextIdentityConsistent(fixture)).toBe(true);
  });

  it('refuses an identity whose details do not give the digest it claims, or that is incomplete', () => {
    const changed = JSON.parse(JSON.stringify(fixture));
    changed.dynamicsClassifier.minProbability = 0.6;
    expect(reviewTextIdentityConsistent(changed)).toBe(false);
    const code = JSON.parse(JSON.stringify(fixture));
    code.codeSha256['direction_text.py'] = '0'.repeat(64);
    expect(reviewTextIdentityConsistent(code)).toBe(false);
    const { ocr, ...withoutOcr } = fixture as Record<string, unknown>;
    expect(ocr).toBeDefined();
    expect(reviewTextIdentityConsistent(withoutOcr)).toBe(false);
    expect(reviewTextIdentityConsistent(undefined)).toBe(false);
    expect(reviewTextIdentityConsistent({ ...fixture, schemaVersion: 'other' })).toBe(false);
    expect(reviewTextIdentityConsistent({ ...fixture, sha256: 'xyz' })).toBe(false);
  });
});
