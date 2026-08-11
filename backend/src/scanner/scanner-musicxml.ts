import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import { ScannerProviderError } from './scanner.errors';

export interface MusicXmlLimits {
  maxNodes: number;
  maxDepth: number;
}

export const DEFAULT_MUSICXML_LIMITS: MusicXmlLimits = { maxNodes: 500_000, maxDepth: 100 };

/**
 * One parser configuration for the whole Scanner path. `processEntities: false`
 * matters: fast-xml-parser has no DTD support, so an entity would be silently
 * dropped rather than expanded or rejected — the DOCTYPE check below refuses it
 * outright instead.
 */
export function musicXmlParser(options: { preserveOrder?: boolean } = {}): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    processEntities: false,
    parseTagValue: false,
    parseAttributeValue: false,
    preserveOrder: options.preserveOrder || false,
    // Keeps `<part>` singular-vs-plural handling predictable when merging.
    isArray: (name) => ['part', 'measure', 'score-part'].includes(name)
  });
}

export function musicXmlBuilder(): XMLBuilder {
  return new XMLBuilder({
    ignoreAttributes: false,
    processEntities: false,
    format: true,
    suppressEmptyNode: true
  });
}

/**
 * Design section 5.5: parse rather than pattern-match, with DTDs, external
 * entities, and network access unavailable, plus node and depth ceilings so a
 * corrupt or hostile document cannot be expanded by a later consumer.
 *
 * Shared by the provider client (validating what HOMR returned) and the merger
 * (validating what we assembled), so assembled output is held to exactly the
 * same bar as provider output.
 */
export function parseValidMusicXml(
  musicXml: Buffer,
  limits: MusicXmlLimits = DEFAULT_MUSICXML_LIMITS,
  code = 'invalid_musicxml'
): { root: any; rootName: 'score-partwise' | 'score-timewise'; document: any } {
  const invalid = (): never => {
    throw new ScannerProviderError('The MusicXML document is not usable', code, false);
  };
  const xmlText = musicXml.toString('utf8');
  if (/<!DOCTYPE/i.test(xmlText) || /<!ENTITY/i.test(xmlText)) invalid();
  if (XMLValidator.validate(xmlText) !== true) invalid();

  let document: any;
  try {
    document = musicXmlParser().parse(xmlText);
  } catch {
    invalid();
  }
  const rootName = document?.['score-partwise']
    ? 'score-partwise'
    : document?.['score-timewise']
      ? 'score-timewise'
      : undefined;
  if (!rootName) invalid();
  const root = document[rootName as string];
  if (!root || typeof root !== 'object') invalid();

  let nodes = 0;
  const walk = (value: unknown, depth: number): void => {
    if (depth > limits.maxDepth) invalid();
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const child of Object.values(value as Record<string, unknown>)) {
      nodes += 1;
      if (nodes > limits.maxNodes) invalid();
      walk(child, depth + 1);
    }
  };
  walk(root, 1);

  if (!root['part-list'] || !root.part) invalid();
  if (!/<measure\b/.test(xmlText)) invalid();
  return { root, rootName: rootName as 'score-partwise' | 'score-timewise', document };
}

export function assertValidMusicXml(musicXml: Buffer, limits?: MusicXmlLimits): void {
  parseValidMusicXml(musicXml, limits);
}
