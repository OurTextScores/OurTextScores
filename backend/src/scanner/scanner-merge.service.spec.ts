import { ScannerMergeService } from './scanner-merge.service';
import { parseValidMusicXml } from './scanner-musicxml';

/** Golden fixture builder for compatible/incompatible page transitions (14.2). */
function page(
  options: {
    parts?: Array<{ id: string; name: string; staves?: number; measures?: number[] }>;
    root?: string;
  } = {}
): Buffer {
  const parts = options.parts ?? [{ id: 'P1', name: 'Piano', measures: [1, 2] }];
  const root = options.root ?? 'score-partwise';
  const partList = parts
    .map((part) => `<score-part id="${part.id}"><part-name>${part.name}</part-name></score-part>`)
    .join('');
  const bodies = parts
    .map((part) => {
      const measures = (part.measures ?? [1, 2])
        .map((number, index) => {
          const attributes =
            index === 0
              ? `<attributes><divisions>1</divisions>${
                  part.staves ? `<staves>${part.staves}</staves>` : ''
                }<key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>`
              : '';
          return `<measure number="${number}">${attributes}<note><rest/><duration>4</duration><type>whole</type></note></measure>`;
        })
        .join('');
      return `<part id="${part.id}">${measures}</part>`;
    })
    .join('');
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?><${root} version="4.0"><work><work-title>Test</work-title></work><part-list>${partList}</part-list>${bodies}</${root}>`,
    'utf8'
  );
}

describe('ScannerMergeService', () => {
  const values: Record<string, string> = {};
  const config = {
    get: jest.fn((key: string, fallback?: string) => values[key] ?? fallback)
  } as any;
  const service = () => new ScannerMergeService(config);

  beforeEach(() => {
    for (const key of Object.keys(values)) delete values[key];
  });

  it('is disabled unless the flag is explicitly on', () => {
    expect(service().enabled).toBe(false);
    values.SCANNER_MULTIPAGE_MERGE_ENABLED = 'true';
    expect(service().enabled).toBe(true);
  });

  describe('compatible pages', () => {
    it('appends measures per part and renumbers monotonically', () => {
      const result = service().merge([
        {
          ordinal: 1,
          pageNumber: 1,
          musicXml: page({ parts: [{ id: 'P1', name: 'Piano', measures: [1, 2] }] })
        },
        // Page 2 restarts numbering at 1, which is exactly what HOMR does.
        {
          ordinal: 2,
          pageNumber: 2,
          musicXml: page({ parts: [{ id: 'P1', name: 'Piano', measures: [1, 2] }] })
        }
      ]);
      expect(result.status).toBe('succeeded');
      if (result.status !== 'succeeded') return;

      const { root } = parseValidMusicXml(result.musicXml);
      const measures = root.part[0].measure;
      expect(measures).toHaveLength(4);
      expect(measures.map((measure: any) => measure['@_number'])).toEqual(['1', '2', '3', '4']);
      expect(result.measureCount).toBe(4);
      expect(result.partCount).toBe(1);
    });

    it('marks each appended page boundary with a new page', () => {
      const result = service().merge([
        { ordinal: 1, pageNumber: 1, musicXml: page() },
        { ordinal: 2, pageNumber: 2, musicXml: page() },
        { ordinal: 3, pageNumber: 3, musicXml: page() }
      ]);
      expect(result.status).toBe('succeeded');
      if (result.status !== 'succeeded') return;
      const { root } = parseValidMusicXml(result.musicXml);
      const withBreaks = root.part[0].measure.filter((measure: any) => measure.print);
      // One per appended page, never on the first.
      expect(withBreaks).toHaveLength(2);
      expect(root.part[0].measure[0].print).toBeUndefined();
      expect(withBreaks[0].print['@_new-page']).toBe('yes');
    });

    it('assembles in saved ordinal order, not the order given', () => {
      const result = service().merge([
        {
          ordinal: 2,
          pageNumber: 7,
          musicXml: page({ parts: [{ id: 'P1', name: 'Piano', measures: [9] }] })
        },
        {
          ordinal: 1,
          pageNumber: 3,
          musicXml: page({ parts: [{ id: 'P1', name: 'Piano', measures: [4] }] })
        }
      ]);
      expect(result.status).toBe('succeeded');
      if (result.status !== 'succeeded') return;
      const { root } = parseValidMusicXml(result.musicXml);
      // The ordinal-1 page contributes the first measure, so its boundary
      // marker is absent and the ordinal-2 page carries it.
      expect(root.part[0].measure).toHaveLength(2);
      expect(root.part[0].measure[1].print['@_new-page']).toBe('yes');
    });

    it('preserves repeated boundary attributes rather than guessing', () => {
      // Section 6.3: only remove a repeated attribute after canonical structural
      // comparison. Until then, keeping it is the safe default.
      const result = service().merge([
        { ordinal: 1, pageNumber: 1, musicXml: page() },
        { ordinal: 2, pageNumber: 2, musicXml: page() }
      ]);
      expect(result.status).toBe('succeeded');
      if (result.status !== 'succeeded') return;
      const { root } = parseValidMusicXml(result.musicXml);
      const withAttributes = root.part[0].measure.filter((measure: any) => measure.attributes);
      expect(withAttributes).toHaveLength(2);
    });

    it('keeps every part when a score has more than one', () => {
      const twoParts = [
        { id: 'P1', name: 'Soprano', measures: [1] },
        { id: 'P2', name: 'Alto', measures: [1] }
      ];
      const result = service().merge([
        { ordinal: 1, pageNumber: 1, musicXml: page({ parts: twoParts }) },
        { ordinal: 2, pageNumber: 2, musicXml: page({ parts: twoParts }) }
      ]);
      expect(result.status).toBe('succeeded');
      if (result.status !== 'succeeded') return;
      const { root } = parseValidMusicXml(result.musicXml);
      expect(root.part).toHaveLength(2);
      expect(root.part[0].measure).toHaveLength(2);
      expect(root.part[1].measure).toHaveLength(2);
    });
  });

  describe('incompatible pages are refused, never silently merged', () => {
    it('refuses a changing part count', () => {
      const result = service().merge([
        { ordinal: 1, pageNumber: 1, musicXml: page({ parts: [{ id: 'P1', name: 'Piano' }] }) },
        {
          ordinal: 2,
          pageNumber: 2,
          musicXml: page({
            parts: [
              { id: 'P1', name: 'Piano' },
              { id: 'P2', name: 'Violin' }
            ]
          })
        }
      ]);
      expect(result).toMatchObject({ status: 'incompatible' });
      if (result.status === 'succeeded') return;
      expect(result.reason).toContain('2 parts');
    });

    it('refuses a part whose name changes between pages', () => {
      const result = service().merge([
        { ordinal: 1, pageNumber: 1, musicXml: page({ parts: [{ id: 'P1', name: 'Piano' }] }) },
        { ordinal: 2, pageNumber: 2, musicXml: page({ parts: [{ id: 'P1', name: 'Organ' }] }) }
      ]);
      expect(result).toMatchObject({ status: 'incompatible' });
      if (result.status === 'succeeded') return;
      expect(result.reason).toContain('Organ');
    });

    it('refuses a staff-count change within a part', () => {
      const result = service().merge([
        {
          ordinal: 1,
          pageNumber: 1,
          musicXml: page({ parts: [{ id: 'P1', name: 'Piano', staves: 2 }] })
        },
        {
          ordinal: 2,
          pageNumber: 2,
          musicXml: page({ parts: [{ id: 'P1', name: 'Piano', staves: 1 }] })
        }
      ]);
      expect(result).toMatchObject({ status: 'incompatible' });
      if (result.status === 'succeeded') return;
      expect(result.reason).toContain('staves');
    });

    it('refuses a non-partwise root', () => {
      const result = service().merge([
        { ordinal: 1, pageNumber: 1, musicXml: page() },
        { ordinal: 2, pageNumber: 2, musicXml: page({ root: 'score-timewise' }) }
      ]);
      expect(result).toMatchObject({ status: 'failed' });
    });

    it('refuses a single page rather than producing a pointless combined file', () => {
      expect(service().merge([{ ordinal: 1, pageNumber: 1, musicXml: page() }])).toMatchObject({
        status: 'incompatible'
      });
    });

    it('reports failure rather than throwing on unparseable input', () => {
      const result = service().merge([
        { ordinal: 1, pageNumber: 1, musicXml: page() },
        { ordinal: 2, pageNumber: 2, musicXml: Buffer.from('<not-music', 'utf8') }
      ]);
      expect(result).toMatchObject({ status: 'failed' });
    });

    it('refuses a document carrying a DOCTYPE', () => {
      const hostile = Buffer.from(
        '<!DOCTYPE score [<!ENTITY a "x">]><score-partwise><part-list><score-part id="P1"/></part-list><part id="P1"><measure number="1"/></part></score-partwise>',
        'utf8'
      );
      expect(
        service().merge([
          { ordinal: 1, pageNumber: 1, musicXml: page() },
          { ordinal: 2, pageNumber: 2, musicXml: hostile }
        ])
      ).toMatchObject({ status: 'failed' });
    });
  });
});
