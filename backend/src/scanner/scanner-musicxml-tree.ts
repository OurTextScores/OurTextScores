/**
 * Traversal helpers for `fast-xml-parser` output in `preserveOrder` mode.
 *
 * Extracted from `scanner-measure-analysis.ts` so splice safety reads MusicXML
 * exactly the way measure analysis does. Two copies of "how do I get a
 * measure's children" is how two readings of the same document start
 * disagreeing about what it says — the same failure mode that put two diff
 * implementations and two renderers in this feature in the first place.
 *
 * Ordered mode represents an element as `{ tagName: [...children], ':@': {...attributes} }`,
 * and text as `{ '#text': '...' }`. Nothing here interprets music; it only
 * walks that shape.
 */
export type OrderedEntry = Record<string, any>;

/** An element's attributes, keyed `@_name` as the parser emits them. */
export const attrs = (entry: OrderedEntry): Record<string, string> => entry?.[':@'] || {};

/** The children of `entry`'s `tag` element. */
export const contents = (entry: OrderedEntry, tag: string): OrderedEntry[] =>
  Array.isArray(entry?.[tag]) ? entry[tag] : [];

/** Direct children named `tag`, in document order. */
export const directEntries = (children: OrderedEntry[], tag: string): OrderedEntry[] =>
  children.filter((entry) => Object.prototype.hasOwnProperty.call(entry, tag));

export const firstEntry = (
  children: OrderedEntry[],
  tag: string
): OrderedEntry | undefined => directEntries(children, tag)[0];

/** The text of `entry`'s `tag` child, trimmed; empty when absent. */
export const entryText = (entry: OrderedEntry | undefined, tag: string): string => {
  const child = entry ? contents(entry, tag) : [];
  const textEntry = child.find((item) => Object.prototype.hasOwnProperty.call(item, '#text'));
  return String(textEntry?.['#text'] ?? '').trim();
};

/** The text of the first `tag` among `children`; empty when absent. */
export const directText = (children: OrderedEntry[], tag: string): string =>
  entryText(firstEntry(children, tag), tag);
