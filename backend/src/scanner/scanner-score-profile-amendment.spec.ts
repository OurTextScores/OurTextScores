import { canonicalScoreProfileJson, ScannerScoreProfile } from './scanner-dual-engine';
import {
  amendProfile,
  currentRevision,
  originalRevision,
  ProfileAmendmentError,
  ScoreProfileRevision,
  widenProfile
} from './scanner-score-profile-amendment';

/** The real profile from job cc2ce56d, the quartet that raised the findings. */
const QUARTET: ScannerScoreProfile = {
  schemaVersion: 'homr.score-profile.v1',
  parts: [
    { stableId: 'violin-1', displayName: 'Violin I', likelyClefs: ['G2'] },
    { stableId: 'violin-2', displayName: 'Violin II', likelyClefs: ['G2'] },
    { stableId: 'viola', displayName: 'Viola', likelyClefs: ['C3', 'G2'] },
    { stableId: 'cello', displayName: 'Cello', likelyClefs: ['F4', 'C4', 'G2'] }
  ]
};

function history(profile = QUARTET): ScoreProfileRevision[] {
  return [{ revision: 1, profile }];
}

describe('widenProfile', () => {
  it('adds a clef without removing the ones already expected', () => {
    const widened = widenProfile(QUARTET, { stableId: 'violin-1', addClefs: ['C3'] });
    expect(widened.parts[0].likelyClefs).toEqual(['G2', 'C3']);
  });

  it('appends rather than reordering, because likelyClefs is a preference order', () => {
    const widened = widenProfile(QUARTET, { stableId: 'cello', addClefs: ['C3'] });
    expect(widened.parts[3].likelyClefs).toEqual(['F4', 'C4', 'G2', 'C3']);
  });

  it('never replaces — the mirror-image finding is the reason', () => {
    // Replacing ['F4'] with ['C4'] would make the next bass-clef page raise the opposite
    // finding, and a reviewer could ping-pong between them forever.
    const narrow: ScannerScoreProfile = {
      schemaVersion: 'homr.score-profile.v1',
      parts: [{ stableId: 'cello', likelyClefs: ['F4'] }]
    };
    expect(widenProfile(narrow, { stableId: 'cello', addClefs: ['C4'] }).parts[0].likelyClefs)
      .toEqual(['F4', 'C4']);
  });

  it('is a no-op, by identity, when the clef is already expected', () => {
    // Identity matters: a new revision here would change the idempotency key and
    // re-decode every remaining page to reach the same answer.
    expect(widenProfile(QUARTET, { stableId: 'cello', addClefs: ['C4'] })).toBe(QUARTET);
  });

  it('produces byte-identical canonical JSON on a no-op', () => {
    const same = widenProfile(QUARTET, { stableId: 'viola', addClefs: ['G2'] });
    expect(canonicalScoreProfileJson(same)).toBe(canonicalScoreProfileJson(QUARTET));
  });

  it('changes the canonical JSON when it really widens, so the fingerprint moves', () => {
    const widened = widenProfile(QUARTET, { stableId: 'viola', addClefs: ['F4'] });
    expect(canonicalScoreProfileJson(widened)).not.toBe(canonicalScoreProfileJson(QUARTET));
  });

  it('leaves every other part untouched', () => {
    const widened = widenProfile(QUARTET, { stableId: 'viola', addClefs: ['F4'] });
    expect(widened.parts[0]).toEqual(QUARTET.parts[0]);
    expect(widened.parts[3]).toEqual(QUARTET.parts[3]);
    expect(widened.parts.map((part) => part.stableId)).toEqual([
      'violin-1',
      'violin-2',
      'viola',
      'cello'
    ]);
  });

  it('does not mutate the profile it was given', () => {
    const before = JSON.stringify(QUARTET);
    widenProfile(QUARTET, { stableId: 'viola', addClefs: ['F4'] });
    expect(JSON.stringify(QUARTET)).toBe(before);
  });

  it('widens a staff count only upward', () => {
    const profile: ScannerScoreProfile = {
      schemaVersion: 'homr.score-profile.v1',
      parts: [{ stableId: 'piano', expectedStaffCount: 2 }]
    };
    expect(widenProfile(profile, { stableId: 'piano', expectedStaffCount: 3 }).parts[0]
      .expectedStaffCount).toBe(3);
    expect(widenProfile(profile, { stableId: 'piano', expectedStaffCount: 1 })).toBe(profile);
  });

  it('refuses an unknown part rather than inventing one', () => {
    // A stableId the profile does not know is a stale client or a bug; appending a part
    // would silently change what the score is declared to be.
    expect(() => widenProfile(QUARTET, { stableId: 'oboe', addClefs: ['G2'] }))
      .toThrow(ProfileAmendmentError);
  });

  it('ignores empty and malformed clef entries', () => {
    expect(widenProfile(QUARTET, { stableId: 'viola', addClefs: ['', null as never] }))
      .toBe(QUARTET);
  });
});

describe('amendProfile', () => {
  it('appends a revision and leaves the old one intact', () => {
    const next = amendProfile(history(), { stableId: 'viola', addClefs: ['F4'] }, 'hash');
    expect(next).toHaveLength(2);
    expect(next[0].profile).toBe(QUARTET);
    expect(next[1].revision).toBe(2);
    expect(currentRevision(next).profile.parts[2].likelyClefs).toEqual(['C3', 'G2', 'F4']);
  });

  it('records who amended it and why', () => {
    const amendment = { stableId: 'viola', addClefs: ['F4'] };
    const next = amendProfile(history(), amendment, 'reviewer-hash');
    expect(next[1]).toMatchObject({ userHash: 'reviewer-hash', amendment });
    expect(next[1].createdAt).toBeInstanceOf(Date);
  });

  it('returns the history unchanged, by identity, for a no-op amendment', () => {
    // The caller uses this to decide whether to re-stamp pages and move the fingerprint.
    const existing = history();
    expect(amendProfile(existing, { stableId: 'cello', addClefs: ['C4'] }, 'hash'))
      .toBe(existing);
  });

  it('amends the current revision, not the original', () => {
    let rows = amendProfile(history(), { stableId: 'viola', addClefs: ['F4'] }, 'hash');
    rows = amendProfile(rows, { stableId: 'viola', addClefs: ['C4'] }, 'hash');
    expect(rows).toHaveLength(3);
    expect(currentRevision(rows).profile.parts[2].likelyClefs).toEqual(['C3', 'G2', 'F4', 'C4']);
    // The original is still exactly what the user supplied.
    expect(originalRevision(rows).profile.parts[2].likelyClefs).toEqual(['C3', 'G2']);
  });

  it('refuses to amend an empty history', () => {
    expect(() => amendProfile([], { stableId: 'viola' }, 'hash')).toThrow(ProfileAmendmentError);
  });
});

describe('currentRevision', () => {
  it('takes the highest revision, not the last element', () => {
    const rows: ScoreProfileRevision[] = [
      { revision: 2, profile: QUARTET },
      { revision: 1, profile: QUARTET }
    ];
    expect(currentRevision(rows).revision).toBe(2);
    expect(originalRevision(rows).revision).toBe(1);
  });

  it('throws on an empty history rather than returning undefined', () => {
    expect(() => currentRevision([])).toThrow(ProfileAmendmentError);
  });
});
