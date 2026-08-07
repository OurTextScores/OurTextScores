import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DEFAULT_MUSICXML_LIMITS, musicXmlBuilder, parseValidMusicXml } from './scanner-musicxml';

export type ScannerMergeStatus = 'not-requested' | 'succeeded' | 'incompatible' | 'failed';

export interface ScannerMergeInput {
  ordinal: number;
  pageNumber: number;
  musicXml: Buffer;
}

export type ScannerMergeResult =
  | { status: 'succeeded'; musicXml: Buffer; measureCount: number; partCount: number }
  | { status: 'incompatible' | 'failed'; reason: string };

interface PageDocument {
  ordinal: number;
  pageNumber: number;
  root: any;
  parts: any[];
  partIds: string[];
  partNames: string[];
  staffCounts: number[];
}

const asArray = (value: unknown): any[] =>
  value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];

const text = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return String((value as any)['#text'] ?? '').trim();
  return String(value).trim();
};

/**
 * Design section 6. HOMR transcribes each page independently, so assembly is a
 * best-effort convenience that must never damage the per-page results.
 *
 * Written rather than adopting `relieur` (section 6.2): that package is at
 * 0.0.1 with eight commits, matches parts by ordinal position with no identity
 * check, and its clef comparison reads the same field twice. The compatibility
 * gate below is the part this code exists for — merging incompatible pages
 * silently would produce a plausible-looking score that is musically wrong,
 * which is worse than offering no merge at all.
 */
@Injectable()
export class ScannerMergeService {
  constructor(private readonly config: ConfigService) {}

  get enabled(): boolean {
    const value = this.config.get<string>('SCANNER_MULTIPAGE_MERGE_ENABLED', 'false').toLowerCase();
    return value === 'true' || value === '1';
  }

  merge(pages: ScannerMergeInput[]): ScannerMergeResult {
    if (pages.length === 0) return { status: 'failed', reason: 'No pages to combine' };
    if (pages.length === 1) {
      return { status: 'incompatible', reason: 'A single page needs no assembly' };
    }

    const ordered = [...pages].sort((left, right) => left.ordinal - right.ordinal);
    let documents: PageDocument[];
    try {
      documents = ordered.map((page) => this.readPage(page));
    } catch (error) {
      return {
        status: 'failed',
        reason: error instanceof Error ? error.message : 'A page could not be parsed'
      };
    }

    const incompatible = this.incompatibility(documents);
    if (incompatible) return { status: 'incompatible', reason: incompatible };

    try {
      return this.assemble(documents);
    } catch (error) {
      return {
        status: 'failed',
        reason: error instanceof Error ? error.message : 'Assembly failed'
      };
    }
  }

  private readPage(page: ScannerMergeInput): PageDocument {
    const { root, rootName } = parseValidMusicXml(
      page.musicXml,
      DEFAULT_MUSICXML_LIMITS,
      'merge_page_unreadable'
    );
    if (rootName !== 'score-partwise') {
      throw new Error(`Page ${page.pageNumber} is not score-partwise`);
    }
    const parts = asArray(root.part);
    if (parts.length === 0) throw new Error(`Page ${page.pageNumber} has no parts`);

    const scoreParts = asArray(root['part-list']?.['score-part']);
    return {
      ordinal: page.ordinal,
      pageNumber: page.pageNumber,
      root,
      parts,
      partIds: parts.map((part) => String(part['@_id'] ?? '')),
      partNames: scoreParts.map((part) => text(part['part-name'])),
      staffCounts: parts.map((part) => {
        const first = asArray(part.measure)[0];
        const staves = text(asArray(first?.attributes)[0]?.staves);
        return staves ? Number(staves) : 1;
      })
    };
  }

  /** Design section 6.3 pre-merge requirements. Returns a reason, or '' if compatible. */
  private incompatibility(documents: PageDocument[]): string {
    const [base, ...rest] = documents;
    for (const page of rest) {
      if (page.parts.length !== base.parts.length) {
        return `Page ${page.pageNumber} has ${page.parts.length} parts but page ${base.pageNumber} has ${base.parts.length}`;
      }
      for (let index = 0; index < base.parts.length; index += 1) {
        // Ordinal position alone is not an identity check (section 6.2). Where
        // both pages name a part, the names must agree.
        const baseName = base.partNames[index] || '';
        const pageName = page.partNames[index] || '';
        if (baseName && pageName && baseName.toLowerCase() !== pageName.toLowerCase()) {
          return `Part ${index + 1} is "${pageName}" on page ${page.pageNumber} but "${baseName}" on page ${base.pageNumber}`;
        }
        if (page.staffCounts[index] !== base.staffCounts[index]) {
          return `Part ${index + 1} changes from ${base.staffCounts[index]} to ${page.staffCounts[index]} staves on page ${page.pageNumber}`;
        }
      }
      for (const part of page.parts) {
        if (asArray(part.measure).length === 0) {
          return `Page ${page.pageNumber} has a part with no measures`;
        }
      }
    }
    return '';
  }

  private assemble(documents: PageDocument[]): ScannerMergeResult {
    const [base, ...rest] = documents;
    // Page 1's identification and part list are the document base (section 6.3).
    const merged = JSON.parse(JSON.stringify(base.root));
    const mergedParts = asArray(merged.part);

    for (const page of rest) {
      for (let index = 0; index < mergedParts.length; index += 1) {
        const appended = JSON.parse(JSON.stringify(asArray(page.parts[index].measure)));
        // Mark the page boundary so the combined score still paginates like the
        // source (section 6.3). Nothing else about the boundary is touched:
        // repeated clef/key/time attributes are preserved deliberately, because
        // removing one without a canonical structural comparison can silently
        // change the music.
        if (appended.length > 0) {
          appended[0] = { print: { '@_new-page': 'yes' }, ...appended[0] };
        }
        mergedParts[index].measure = [...asArray(mergedParts[index].measure), ...appended];
      }
    }

    // Monotonic renumbering per part; page-local numbering restarts otherwise.
    let measureCount = 0;
    for (const part of mergedParts) {
      const measures = asArray(part.measure);
      measures.forEach((measure: any, index: number) => {
        measure['@_number'] = String(index + 1);
      });
      measureCount = Math.max(measureCount, measures.length);
    }
    merged.part = mergedParts;

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${musicXmlBuilder().build({
      'score-partwise': merged
    })}`;
    const musicXml = Buffer.from(xml, 'utf8');
    // Assembled output is held to the same bar as provider output (section 6.3).
    parseValidMusicXml(musicXml, DEFAULT_MUSICXML_LIMITS, 'merge_output_invalid');
    return {
      status: 'succeeded',
      musicXml,
      measureCount,
      partCount: mergedParts.length
    };
  }
}
