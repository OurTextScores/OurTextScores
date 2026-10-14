import { recoverReviewProposalMapping } from './scanner-review-proposal-mapping';
import { normaliseReview } from './scanner-provider.service';
const token = (pitch = 'C4') => ['note_4', pitch, '_', '_', '_', 'upper'];
const separator = ['newline', '.', 'none', 'none', 'none', 'none'];
const staff = (index: number, systemIndex: number, pitch: string) => ({
  index,
  partIndex: 0,
  systemIndex,
  tokens: [token(pitch)],
  symbols: [
    {
      index: 0,
      heads: {
        pitch: { chosen: pitch, confidence: 0.4, alternatives: [{ value: 'E4', confidence: 0.39 }] }
      }
    }
  ]
});

it('preserves verified provider mappings through review normalization', () => {
  const raw = staff(0, 0, 'C4');
  Object.assign(raw.symbols[0], { proposalVoiceIndex: 2, proposalSymbolIndex: 14 });
  expect(normaliseReview({ staves: [raw] })?.staves[0].symbols[0]).toMatchObject({
    proposalVoiceIndex: 2,
    proposalSymbolIndex: 14
  });
  Object.assign(raw.symbols[0], { proposalVoiceIndex: -1, proposalSymbolIndex: '14' });
  expect(normaliseReview({ staves: [raw] })?.staves[0].symbols[0]).not.toHaveProperty(
    'proposalVoiceIndex'
  );
});

it('recovers legacy mappings across systems, with an optional final newline', () => {
  const staves = [staff(7, 1, 'D4'), staff(4, 0, 'C4')];
  const recovered = recoverReviewProposalMapping(staves, [
    [token('C4'), separator, token('D4'), separator]
  ]);
  expect(recovered?.[0].symbols[0]).toMatchObject({
    proposalVoiceIndex: 0,
    proposalSymbolIndex: 2
  });
  expect(recovered?.[1].symbols[0]).toMatchObject({
    proposalVoiceIndex: 0,
    proposalSymbolIndex: 0
  });
  expect(staves[0].symbols[0]).not.toHaveProperty('proposalVoiceIndex');
});

it('refuses recovery when any musical token differs or a system is missing', () => {
  expect(recoverReviewProposalMapping([staff(0, 0, 'C4')], [[token('D4')]])).toBeNull();
  expect(recoverReviewProposalMapping([staff(0, 1, 'C4')], [[token('C4')]])).toBeNull();
  expect(
    recoverReviewProposalMapping([staff(0, 0, 'C4')], [[token('C4'), token('D4')]])
  ).toBeNull();
});
