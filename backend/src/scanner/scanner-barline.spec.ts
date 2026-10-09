import { isBarlineRhythm } from './scanner-barline';
import { locateSymbol } from './scanner-locate';

describe('shared measure boundaries', () => {
  it.each(['barline', 'doublebarline', 'bolddoublebarline', 'repeatStart', 'repeatEnd', 'repeatEndStart'])(
    'uses %s for review fallback location', (boundary) => {
      expect(isBarlineRhythm(boundary)).toBe(true);
      const band = locateSymbol([['note_4'], [boundary], ['note_4'], ['barline']], 2);
      expect(band).toEqual({ start: 1 / 3, end: 2 / 3, basis: 'measure' });
    }
  );
  it.each(['voltaStart', 'voltaStop', 'voltaDiscontinue', 'timeSignature/4', 'note_4'])(
    'does not treat %s as another measure boundary', (rhythm) => {
      expect(isBarlineRhythm(rhythm)).toBe(false);
    }
  );
});
