import type { ReviewStaff } from './scanner-review';

/** Recover legacy mappings only when every staff token matches its retained voice/system. */
export function recoverReviewProposalMapping(
  staves: ReviewStaff[],
  proposalVoices: unknown
): ReviewStaff[] | null {
  if (!Array.isArray(proposalVoices) || staves.length === 0) return null;
  const byPart = new Map<number, ReviewStaff[]>();
  const identities = new Set<string>();
  const staffIndices = new Set<number>();
  for (const staff of staves) {
    if (!Number.isInteger(staff.index) || staffIndices.has(staff.index)) return null;
    staffIndices.add(staff.index);
    if (
      !Number.isInteger(staff.partIndex) ||
      staff.partIndex! < 0 ||
      !Number.isInteger(staff.systemIndex) ||
      staff.systemIndex! < 0 ||
      !Array.isArray(staff.tokens)
    )
      return null;
    const id = `${staff.partIndex}:${staff.systemIndex}`;
    if (identities.has(id)) return null;
    identities.add(id);
    const group = byPart.get(staff.partIndex!) || [];
    group.push(staff);
    byPart.set(staff.partIndex!, group);
  }
  if (byPart.size !== proposalVoices.length) return null;
  const mapped = new Map<number, ReviewStaff>();
  for (let partIndex = 0; partIndex < proposalVoices.length; partIndex += 1) {
    const voice = proposalVoices[partIndex];
    const systems = byPart.get(partIndex)?.sort((a, b) => a.systemIndex! - b.systemIndex!);
    if (!Array.isArray(voice) || !systems) return null;
    let offset = 0;
    for (let systemIndex = 0; systemIndex < systems.length; systemIndex += 1) {
      const staff = systems[systemIndex];
      if (staff.systemIndex !== systemIndex) return null;
      const tokens = staff.tokens!;
      if (
        tokens.some(
          (token, index) => JSON.stringify(token) !== JSON.stringify(voice[offset + index])
        )
      )
        return null;
      if (
        staff.symbols.some(
          (symbol) =>
            !Number.isInteger(symbol.index) || symbol.index < 0 || symbol.index >= tokens.length
        )
      )
        return null;
      const start = offset;
      mapped.set(staff.index, {
        ...staff,
        symbols: staff.symbols.map((symbol) => ({
          ...symbol,
          proposalVoiceIndex: partIndex,
          proposalSymbolIndex: start + symbol.index
        }))
      });
      offset += tokens.length;
      // Separator metadata differs between capture versions. It is never a
      // musical token or a review choice. A final separator is optional.
      if (systemIndex < systems.length - 1 || offset < voice.length) {
        if (!Array.isArray(voice[offset]) || voice[offset][0] !== 'newline') return null;
        offset += 1;
      }
    }
    if (offset !== voice.length) return null;
  }
  return staves.map((staff) => mapped.get(staff.index)!);
}
