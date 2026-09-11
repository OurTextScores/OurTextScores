import { applyDispositions, dispositionFor, StandingDisposition } from './scanner-finding-dispositions';

const CLEF = { kind: 'clef_profile_mismatch', part: 'cello' };
const CLEF_VIOLA = { kind: 'clef_profile_mismatch', part: 'viola' };
const SLUR = { kind: 'dangling_slur_start' };

function standing(
  kind: string,
  part: string | null,
  disposition: StandingDisposition['disposition']
): StandingDisposition {
  return { kind, part, disposition };
}

describe('dispositionFor', () => {
  it('matches a kind-wide decision to every part of that kind', () => {
    const all = [standing('clef_profile_mismatch', null, 'acknowledged')];
    expect(dispositionFor(CLEF, all)?.disposition).toBe('acknowledged');
    expect(dispositionFor(CLEF_VIOLA, all)?.disposition).toBe('acknowledged');
  });

  it('prefers a part-specific decision over a kind-wide one', () => {
    // The narrower statement is the more considered one, and the one a reviewer would be
    // surprised to lose.
    const both = [
      standing('clef_profile_mismatch', null, 'reading-flagged'),
      standing('clef_profile_mismatch', 'cello', 'profile-amended')
    ];
    expect(dispositionFor(CLEF, both)?.disposition).toBe('profile-amended');
    expect(dispositionFor(CLEF_VIOLA, both)?.disposition).toBe('reading-flagged');
  });

  it('does not apply another part’s decision to a finding with no part', () => {
    // Six of the seventeen findings on the real job carried no part at all. Falling back
    // to some arbitrary part would apply a judgement about the cello to a slur.
    const cello = [standing('dangling_slur_start', 'cello', 'acknowledged')];
    expect(dispositionFor(SLUR, cello)).toBeUndefined();
  });

  it('matches a kind-wide decision to a finding with no part', () => {
    const all = [standing('dangling_slur_start', null, 'acknowledged')];
    expect(dispositionFor(SLUR, all)?.disposition).toBe('acknowledged');
  });

  it('never matches across kinds', () => {
    expect(dispositionFor(CLEF, [standing('time_signature_mismatch', null, 'acknowledged')]))
      .toBeUndefined();
  });

  it('survives empty and missing inputs', () => {
    expect(dispositionFor(CLEF, [])).toBeUndefined();
    expect(dispositionFor(CLEF, undefined as never)).toBeUndefined();
  });
});

describe('applyDispositions', () => {
  it('leaves undecided findings open and unannotated', () => {
    const summary = applyDispositions([CLEF, SLUR], []);
    expect(summary.openCount).toBe(2);
    expect(summary.suppressedCount).toBe(0);
    expect(summary.findings.every((entry) => entry.disposition === undefined)).toBe(true);
  });

  it('suppresses an amended profile and an acknowledgement', () => {
    const summary = applyDispositions(
      [CLEF, CLEF_VIOLA],
      [
        standing('clef_profile_mismatch', 'cello', 'profile-amended'),
        standing('clef_profile_mismatch', 'viola', 'acknowledged')
      ]
    );
    expect(summary.suppressedCount).toBe(2);
    expect(summary.openCount).toBe(0);
  });

  it('keeps a flagged reading open, and counts it as flagged', () => {
    // The point of the whole distinction: a flagged finding is an unresolved problem.
    // Hiding it because someone noticed it would lose the only record that anything is
    // wrong.
    const summary = applyDispositions(
      [CLEF],
      [standing('clef_profile_mismatch', 'cello', 'reading-flagged')]
    );
    expect(summary.findings[0].suppressed).toBe(false);
    expect(summary.openCount).toBe(1);
    expect(summary.flaggedCount).toBe(1);
  });

  it('reports which decision matched, so the UI need not imply the wrong scope', () => {
    const summary = applyDispositions(
      [CLEF],
      [standing('clef_profile_mismatch', null, 'acknowledged')]
    );
    // Matched by an all-parts decision, even though the finding names the cello.
    expect(summary.findings[0].matchedPart).toBeNull();
  });

  it('never drops a finding — suppression is a view, not a deletion', () => {
    const findings = [CLEF, CLEF_VIOLA, SLUR];
    const summary = applyDispositions(findings, [
      standing('clef_profile_mismatch', null, 'acknowledged')
    ]);
    expect(summary.findings).toHaveLength(3);
    expect(summary.findings.map((entry) => entry.finding)).toEqual(findings);
  });

  it('handles the real job’s shape: 17 findings, three kinds, no parts', () => {
    const real = [
      ...Array.from({ length: 11 }, () => ({ kind: 'profile_layout_deviation' })),
      ...Array.from({ length: 2 }, () => ({ kind: 'dangling_slur_stop' })),
      ...Array.from({ length: 4 }, () => ({ kind: 'dangling_slur_start' }))
    ];
    const summary = applyDispositions(real, [
      standing('profile_layout_deviation', null, 'reading-flagged')
    ]);
    // The layout deviations are the Phase 7 defect: flagged, and still open.
    expect(summary.flaggedCount).toBe(11);
    expect(summary.suppressedCount).toBe(0);
    expect(summary.openCount).toBe(17);
  });
});
