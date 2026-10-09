/** Measure-boundary rhythms shared by lyric anchors and review location. */
const BARLINE_RHYTHMS = new Set([
  'barline', 'doublebarline', 'bolddoublebarline',
  'repeatStart', 'repeatEnd', 'repeatEndStart',
  // Legacy review artifacts.
  'barline_repeat', 'repeat'
]);

export function isBarlineRhythm(rhythm: string): boolean {
  return BARLINE_RHYTHMS.has(rhythm) || rhythm.startsWith('barline');
}
