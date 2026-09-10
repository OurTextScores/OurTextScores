import { ScannerOtsHomrProviderService } from './scanner-ots-homr-provider.service';
import {
  canonicalScoreProfileJson,
  isScannerOtsHomrEngineOptions,
  isScannerScoreProfile,
  MAX_SCORE_PROFILE_PARTS,
  SCORE_PROFILE_SCHEMA_VERSION,
  ScannerScoreProfile
} from './scanner-dual-engine';

const quartet = (): ScannerScoreProfile => ({
  schemaVersion: SCORE_PROFILE_SCHEMA_VERSION,
  parts: [
    { stableId: 'violin-1', displayName: 'Violin I', likelyClefs: ['G2'] },
    { stableId: 'violin-2', displayName: 'Violin II', likelyClefs: ['G2'] },
    { stableId: 'viola', displayName: 'Viola', likelyClefs: ['C3', 'G2'] },
    // A cello legitimately reads in all three; a profile that said only bass would
    // raise a finding on ordinary music.
    { stableId: 'cello', displayName: 'Cello', likelyClefs: ['F4', 'C4', 'G2'] }
  ]
});

describe('score profile option', () => {
  it('accepts a profile alongside the detector, and without one', () => {
    expect(isScannerOtsHomrEngineOptions({ textDetector: 'none' })).toBe(true);
    expect(
      isScannerOtsHomrEngineOptions({ textDetector: 'lyrics', scoreProfile: quartet() })
    ).toBe(true);
  });

  it('still rejects policy this build does not understand', () => {
    // The old check counted keys; widening it must not turn into accepting anything.
    expect(
      isScannerOtsHomrEngineOptions({ textDetector: 'none', somethingElse: true })
    ).toBe(false);
    expect(isScannerOtsHomrEngineOptions({ textDetector: 'nope' })).toBe(false);
  });

  it('refuses a schema version it cannot read rather than guessing at the shape', () => {
    expect(
      isScannerScoreProfile({ ...quartet(), schemaVersion: 'homr.score-profile.v2' })
    ).toBe(false);
  });

  it('refuses duplicate part ids, which make a finding unattributable', () => {
    const profile = quartet();
    profile.parts[1].stableId = 'violin-1';
    expect(isScannerScoreProfile(profile)).toBe(false);
  });

  it('refuses an empty, oversized, or malformed part list', () => {
    expect(isScannerScoreProfile({ ...quartet(), parts: [] })).toBe(false);
    expect(
      isScannerScoreProfile({
        ...quartet(),
        parts: Array.from({ length: MAX_SCORE_PROFILE_PARTS + 1 }, (_, index) => ({
          stableId: `p${index}`
        }))
      })
    ).toBe(false);
    expect(isScannerScoreProfile({ ...quartet(), parts: [{ stableId: '  ' }] })).toBe(false);
    expect(
      isScannerScoreProfile({ ...quartet(), parts: [{ stableId: 'a', likelyClefs: [1] }] })
    ).toBe(false);
    expect(
      isScannerScoreProfile({
        ...quartet(),
        parts: [{ stableId: 'a', expectedStaffCount: 0 }]
      })
    ).toBe(false);
  });

  describe('canonical form', () => {
    it('is stable across key order, so the same profile hashes the same', () => {
      const a: any = { schemaVersion: SCORE_PROFILE_SCHEMA_VERSION, parts: [
        { stableId: 'cello', likelyClefs: ['F4'], displayName: 'Cello' }
      ] };
      const b: any = { parts: [
        { displayName: 'Cello', stableId: 'cello', likelyClefs: ['F4'] }
      ], schemaVersion: SCORE_PROFILE_SCHEMA_VERSION };
      expect(canonicalScoreProfileJson(a)).toEqual(canonicalScoreProfileJson(b));
    });

    it('omits absent fields rather than writing nulls', () => {
      const json = canonicalScoreProfileJson({
        schemaVersion: SCORE_PROFILE_SCHEMA_VERSION,
        parts: [{ stableId: 'cello' }]
      });
      expect(json).toEqual(
        JSON.stringify({ schemaVersion: SCORE_PROFILE_SCHEMA_VERSION, parts: [{ stableId: 'cello' }] })
      );
    });

    it('keeps part order, because a reordered score is a different score', () => {
      const profile = quartet();
      const reversed = { ...profile, parts: [...profile.parts].reverse() };
      expect(canonicalScoreProfileJson(profile)).not.toEqual(
        canonicalScoreProfileJson(reversed)
      );
    });
  });
});

describe('score profile and the idempotency fingerprint', () => {
  const values: Record<string, string> = {
    SCANNER_OTS_HOMR_PROVIDER_KIND: 'modal',
    SCANNER_OTS_HOMR_PROVIDER_URL: 'https://ots-homr.example',
    SCANNER_EXPECTED_OTS_HOMR_CORE_SHA256: 'a'.repeat(64),
    SCANNER_EXPECTED_OTS_HOMR_CORE_REVISION: 'core-revision'
  };
  const service = new ScannerOtsHomrProviderService({
    get: jest.fn((key: string, fallback?: string) => values[key] ?? fallback)
  } as any);
  const base = {
    inputSha256: 'f'.repeat(64),
    pageNumber: 1,
    detectTitle: false,
    generation: 1
  };
  const keyFor = (scoreProfile?: ScannerScoreProfile) =>
    service.createIdempotencyKey({
      ...base,
      engineOptions: { textDetector: 'none' as const, ...(scoreProfile ? { scoreProfile } : {}) }
    });

  it('a profile change is a new attempt, never a relabelled old one', () => {
    const withProfile = keyFor(quartet());
    expect(withProfile).not.toEqual(keyFor());

    const altered = quartet();
    altered.parts[3].likelyClefs = ['F4'];
    expect(keyFor(altered)).not.toEqual(withProfile);
  });

  it('the same profile always yields the same key', () => {
    expect(keyFor(quartet())).toEqual(keyFor(quartet()));
  });

  it('removing a profile restores the key it had without one', () => {
    keyFor(quartet());
    expect(keyFor()).toEqual(keyFor(undefined));
  });
});

describe('cross-staff findings from the provider', () => {
  const service: any = new ScannerOtsHomrProviderService({
    get: jest.fn((_key: string, fallback?: string) => fallback)
  } as any);
  const parse = (value: unknown) => service.crossStaffFindings(value);

  it('keeps a well-formed finding with everything it carries', () => {
    expect(
      parse([
        {
          kind: 'clef_profile_mismatch',
          message: "staff 3 decoded clef 'G2', profile part 'cello' expects one of ['F4']",
          system: 2,
          staffIndices: [3],
          part: 'cello'
        }
      ])
    ).toEqual([
      {
        kind: 'clef_profile_mismatch',
        message: "staff 3 decoded clef 'G2', profile part 'cello' expects one of ['F4']",
        system: 2,
        staffIndices: [3],
        part: 'cello'
      }
    ]);
  });

  it('drops a malformed finding rather than failing the page', () => {
    // Supplementary evidence: losing an annotation costs a reviewer a prompt, and
    // failing here would cost them the whole page.
    expect(parse([{ kind: 'x' }, { message: 'y' }, null, 'nope'])).toBeUndefined();
    expect(parse([{ kind: 'a', message: 'b' }, { kind: 'c' }])).toEqual([
      { kind: 'a', message: 'b' }
    ]);
  });

  it('omits optional fields rather than carrying junk', () => {
    expect(
      parse([{ kind: 'a', message: 'b', system: 'two', staffIndices: ['x'], part: '' }])
    ).toEqual([{ kind: 'a', message: 'b' }]);
  });

  it('is absent, not empty, when there is nothing to say', () => {
    expect(parse([])).toBeUndefined();
    expect(parse(undefined)).toBeUndefined();
  });
});
