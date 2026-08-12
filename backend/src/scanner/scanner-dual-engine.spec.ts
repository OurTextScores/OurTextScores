import {
  SCANNER_ARTIFACT_BUILDERS,
  scannerArtifactInputSignature,
  scannerArtifactInputMatches,
  scannerAggregatePageStatus,
  scannerBlockContentSignature,
  scannerEngineArtifactLocators,
  scannerEnginePlan,
  scannerEnginePlanForJob,
  scannerEngineReviewContentSignature,
  scannerHomrRun,
  scannerMergedScoreBasis,
  scannerMergedScoreStale,
  uniqueScannerStorageLocators,
  withScannerArtifactInputSignature,
  withScannerEngineRun,
  withScannerHomrRun
} from './scanner-dual-engine';
import { scannerProviderIdempotencyKey } from './scanner-provider.contract';
import {
  effectivePageMusicXml,
  effectivePageMusicXmlSelection,
  pageMusicXmlSuperseded
} from './scanner.constants';

describe('dual-engine content identity', () => {
  it('synthesizes legacy HOMR state and dual-writes it without disturbing Transcoda', () => {
    const transcoda: any = {
      engine: 'transcoda',
      status: 'succeeded',
      attempts: 1,
      idempotencyKey: 'transcoda-key',
      artifacts: { kern: { objectKey: 'page.krn' } }
    };
    const legacy: any = {
      pageNumber: 1,
      ordinal: 1,
      included: true,
      rotationDegrees: 0,
      status: 'succeeded',
      attempts: 2,
      providerAttempts: 3,
      idempotencyKey: 'homr-key',
      providerRequestId: 'homr-request',
      musicXml: { objectKey: 'page.musicxml' },
      engines: { transcoda }
    };

    expect(
      scannerHomrRun(legacy, { providerRevision: 'homr-service', modelRevision: 'homr-model' })
    ).toMatchObject({
      engine: 'homr',
      status: 'succeeded',
      attempts: 2,
      providerAttempts: 3,
      idempotencyKey: 'homr-key',
      providerRevision: 'homr-service',
      modelRevision: 'homr-model',
      artifacts: { musicXml: { objectKey: 'page.musicxml' } }
    });

    const migrated = withScannerHomrRun(legacy, {
      providerRevision: 'homr-service',
      modelRevision: 'homr-model'
    });
    expect(migrated.engines?.homr).toMatchObject({ engine: 'homr', idempotencyKey: 'homr-key' });
    expect(migrated.engines?.transcoda).toBe(transcoda);
    expect(scannerEngineArtifactLocators(migrated)).toEqual(
      expect.arrayContaining([{ objectKey: 'page.musicxml' }, { objectKey: 'page.krn' }])
    );
    expect(scannerEngineArtifactLocators(migrated)).toHaveLength(2);

    const legacyReviewed = { objectKey: 'page-reviewed.musicxml' } as any;
    expect(
      scannerHomrRun({
        ...legacy,
        reviewedMusicXml: legacyReviewed,
        engines: {
          ...legacy.engines,
          homr: {
            engine: 'homr',
            status: 'succeeded',
            attempts: 2,
            idempotencyKey: 'homr-key',
            artifacts: {}
          }
        }
      })
    ).toMatchObject({
      reviewedMusicXml: legacyReviewed,
      artifacts: { musicXml: { objectKey: 'page.musicxml' } }
    });
  });

  it('deduplicates dual-written artifact locators by storage identity', () => {
    const locator: any = {
      bucket: 'scanner',
      objectKey: 'page.musicxml',
      checksumSha256: 'one'
    };
    expect(
      uniqueScannerStorageLocators([
        locator,
        { ...locator, checksumSha256: 'same-object-new-metadata' },
        undefined
      ])
    ).toEqual([{ ...locator, checksumSha256: 'same-object-new-metadata' }]);
  });

  it('owns reviewed artifacts in the engine run and binds decisions to their content', () => {
    const reviewed = { bucket: 'scanner', objectKey: 'reviewed.musicxml' } as any;
    const run: any = {
      engine: 'future-review',
      status: 'succeeded',
      attempts: 1,
      idempotencyKey: 'future-key',
      recognitionRaster: { checksumSha256: 'a'.repeat(64), width: 100, height: 200 },
      artifacts: { musicXml: { checksumSha256: 'raw' } },
      reviewedMusicXml: reviewed,
      review: { staves: [] },
      corrections: []
    };
    const page: any = { engines: { 'future-review': run } };
    const signature = scannerEngineReviewContentSignature(run);

    expect(scannerEngineArtifactLocators(page)).toContain(reviewed);
    expect(signature).toMatch(/^scanner-engine-review-v1:[a-f0-9]{64}$/);
    expect(
      scannerEngineReviewContentSignature({
        ...run,
        corrections: [{ spotId: 0, chosen: 'D4' }]
      })
    ).not.toBe(signature);
    expect(
      scannerEngineReviewContentSignature({
        ...run,
        recognitionRaster: { ...run.recognitionRaster, checksumSha256: 'b'.repeat(64) }
      })
    ).not.toBe(signature);
  });

  it('includes engine identity in provider idempotency keys', () => {
    const input = {
      modelRevision: 'model-v1',
      preprocessingRevision: 'preprocess-v1',
      inputSha256: 'page',
      pageNumber: 1,
      detectTitle: false,
      generation: 1
    };
    expect(scannerProviderIdempotencyKey({ engine: 'homr', ...input })).not.toBe(
      scannerProviderIdempotencyKey({ engine: 'transcoda', ...input })
    );
  });

  it('derives a usable page when one engine succeeds and the other fails', () => {
    const run = (engine: string, status: any): any => ({
      engine,
      status,
      attempts: 1,
      idempotencyKey: `${engine}-key`,
      artifacts: {}
    });

    expect(
      scannerAggregatePageStatus({
        homr: run('homr', 'failed'),
        transcoda: run('transcoda', 'succeeded')
      })
    ).toBe('succeeded');
    expect(
      scannerAggregatePageStatus({
        homr: run('homr', 'succeeded'),
        transcoda: run('transcoda', 'running')
      })
    ).toBe('running');
    expect(scannerAggregatePageStatus({ homr: run('homr', 'failed') })).toBe('failed');
    expect(scannerAggregatePageStatus({}, false)).toBe('skipped');
  });

  it('accepts a third engine without changing aggregate or artifact helpers', () => {
    const audiverisMusicXml = { objectKey: 'audiveris.musicxml' } as any;
    const page = withScannerEngineRun(
      {
        pageNumber: 1,
        ordinal: 1,
        rotationDegrees: 0,
        included: true,
        status: 'failed',
        attempts: 1,
        idempotencyKey: 'homr-key',
        engines: {
          homr: {
            engine: 'homr',
            status: 'failed',
            attempts: 1,
            idempotencyKey: 'homr-key',
            artifacts: {}
          }
        }
      },
      {
        engine: 'audiveris-5',
        status: 'succeeded',
        attempts: 1,
        idempotencyKey: 'audiveris-key',
        artifacts: { musicXml: audiverisMusicXml }
      }
    );

    expect(page.status).toBe('succeeded');
    expect(page.engines?.['audiveris-5']?.artifacts.musicXml).toBe(audiverisMusicXml);
    expect(scannerEngineArtifactLocators(page)).toContain(audiverisMusicXml);
  });

  it('persists ordered engine policy and infers recorded engines for legacy jobs', () => {
    const plan = scannerEnginePlan(['homr', 'audiveris-5', 'transcoda'], 'audiveris-5');
    expect(plan).toMatchObject({
      version: 'scanner-engine-plan-v1',
      engineIds: ['homr', 'audiveris-5', 'transcoda'],
      primaryEngineId: 'audiveris-5',
      fallbackEngineIds: ['homr', 'transcoda']
    });
    expect(plan.capabilitySnapshots['audiveris-5']).toMatchObject({
      displayName: 'audiveris-5',
      outputArtifactKinds: ['musicxml']
    });
    expect(scannerEnginePlanForJob({ enginePlan: plan })).toEqual(plan);

    const inferred = scannerEnginePlanForJob({
      pages: [{ engines: { 'audiveris-5': {} as any } } as any]
    });
    expect(inferred.engineIds).toEqual(['homr', 'audiveris-5']);
    expect(() => scannerEnginePlan(['homr', 'homr'])).toThrow('Invalid scanner engine plan');
    expect(() => scannerEnginePlan(['homr', '../unsafe'])).toThrow('Invalid scanner engine plan');
  });

  it('uses Transcoda only as a fallback when HOMR has no usable MusicXML', () => {
    const homr = { objectKey: 'homr.musicxml' } as any;
    const transcoda = { objectKey: 'transcoda.musicxml' } as any;
    const page: any = {
      included: true,
      status: 'failed',
      engines: {
        homr: {
          engine: 'homr',
          status: 'failed',
          attempts: 1,
          idempotencyKey: 'homr-key',
          artifacts: {}
        }
      }
    };
    const withTranscoda = withScannerEngineRun(page, {
      engine: 'transcoda',
      status: 'succeeded',
      attempts: 1,
      idempotencyKey: 'transcoda-key',
      artifacts: { musicXml: transcoda }
    });

    expect(withTranscoda.status).toBe('succeeded');
    expect(effectivePageMusicXml(withTranscoda)).toBe(transcoda);
    expect(effectivePageMusicXml({ ...withTranscoda, musicXml: homr })).toBe(transcoda);
    expect(
      effectivePageMusicXml({
        musicXml: homr,
        engines: { transcoda: withTranscoda.engines?.transcoda }
      } as any)
    ).toBe(homr);
  });

  it('resolves effective MusicXML in persisted primary and fallback order', () => {
    const audiveris = { objectKey: 'audiveris.musicxml' } as any;
    const transcoda = { objectKey: 'transcoda.musicxml' } as any;
    const page: any = {
      engines: {
        homr: { engine: 'homr', status: 'failed', artifacts: {} },
        'audiveris-5': {
          engine: 'audiveris-5',
          status: 'succeeded',
          artifacts: { musicXml: audiveris }
        },
        transcoda: {
          engine: 'transcoda',
          status: 'succeeded',
          artifacts: { musicXml: transcoda }
        }
      }
    };

    expect(
      effectivePageMusicXml(page, scannerEnginePlan(['homr', 'transcoda', 'audiveris-5']))
    ).toBe(transcoda);
    expect(
      effectivePageMusicXml(page, scannerEnginePlan(['homr', 'audiveris-5', 'transcoda']))
    ).toBe(audiveris);
    expect(
      effectivePageMusicXmlSelection(
        page,
        scannerEnginePlan(['audiveris-5', 'transcoda'], 'audiveris-5')
      )
    ).toEqual({ musicXml: audiveris, engineId: 'audiveris-5' });
    expect(
      effectivePageMusicXmlSelection(
        { ...page, reviewedMusicXml: { objectKey: 'reviewed.musicxml' } } as any,
        scannerEnginePlan(['audiveris-5', 'transcoda'], 'audiveris-5')
      )
    ).toEqual({ musicXml: audiveris, engineId: 'audiveris-5' });

    const reviewedAudiveris = { objectKey: 'audiveris-reviewed.musicxml' };
    expect(
      effectivePageMusicXmlSelection(
        {
          ...page,
          engines: {
            ...page.engines,
            'audiveris-5': { ...page.engines?.['audiveris-5'], reviewedMusicXml: reviewedAudiveris }
          }
        } as any,
        scannerEnginePlan(['audiveris-5', 'transcoda'], 'audiveris-5')
      )
    ).toEqual({ musicXml: reviewedAudiveris, engineId: 'audiveris-5' });
  });

  it('binds materialized artifacts to page order, checksums and builder version', () => {
    const input = {
      builderVersion: 'bundle-v1',
      pages: [
        { ordinal: 1, checksumSha256: 'page-one' },
        { ordinal: 2, checksumSha256: 'page-two' }
      ]
    };
    const signature = scannerArtifactInputSignature(input);

    expect(signature).toMatch(/^scanner-artifact-input-v1:[a-f0-9]{64}$/);
    expect(scannerArtifactInputSignature(input)).toBe(signature);
    expect(
      scannerArtifactInputSignature({ pages: input.pages, builderVersion: input.builderVersion })
    ).toBe(signature);
    expect(scannerArtifactInputSignature({ ...input, builderVersion: 'bundle-v2' })).not.toBe(
      signature
    );
    expect(scannerArtifactInputSignature({ ...input, pages: [...input.pages].reverse() })).not.toBe(
      signature
    );
    expect(
      scannerArtifactInputSignature({
        ...input,
        pages: [input.pages[0], { ...input.pages[1], checksumSha256: 'reviewed-page-two' }]
      })
    ).not.toBe(signature);

    const locator: any = {
      bucket: 'scanner',
      objectKey: 'results.zip',
      checksumSha256: 'zip'
    };
    const signed = withScannerArtifactInputSignature(
      locator,
      SCANNER_ARTIFACT_BUILDERS.resultsZip,
      input.pages
    );
    expect(
      scannerArtifactInputMatches(signed, SCANNER_ARTIFACT_BUILDERS.resultsZip, input.pages)
    ).toBe(true);
    expect(
      scannerArtifactInputMatches(signed, SCANNER_ARTIFACT_BUILDERS.previewPdf, input.pages)
    ).toBe(false);
    expect(
      scannerArtifactInputMatches(signed, SCANNER_ARTIFACT_BUILDERS.resultsZip, [
        input.pages[0],
        { ...input.pages[1], checksumSha256: 'changed' }
      ])
    ).toBe(false);
  });

  it('invalidates a block decision when either artifact or rich descriptor changes', () => {
    const input: Parameters<typeof scannerBlockContentSignature>[0] = {
      sides: [
        {
          role: 'base' as const,
          engineId: 'homr',
          artifactChecksumSha256: 'homr-v1',
          descriptorHashes: ['homr-m1']
        },
        {
          role: 'candidate' as const,
          engineId: 'audiveris-5',
          artifactChecksumSha256: 'audiveris-v1',
          descriptorHashes: ['audiveris-m1']
        }
      ],
      partMatchVersion: 'part-match-v1',
      alignmentVersion: 'measure-alignment-v1',
      descriptorVersion: 'measure-descriptor-v1',
      stablePartKey: 'part-1',
      contextBeforeHash: 'before',
      contextAfterHash: 'after'
    };
    const signature = scannerBlockContentSignature(input);

    expect(signature).toMatch(/^scanner-block-content-v2:[a-f0-9]{64}$/);
    expect(scannerBlockContentSignature(input)).toBe(signature);
    expect(
      scannerBlockContentSignature({
        ...input,
        sides: [
          { ...input.sides[0], artifactChecksumSha256: 'homr-after-spot-correction' },
          input.sides[1]
        ]
      })
    ).not.toBe(signature);
    expect(
      scannerBlockContentSignature({
        ...input,
        sides: [
          input.sides[0],
          { ...input.sides[1], descriptorHashes: ['audiveris-m1-different-reading'] }
        ]
      })
    ).not.toBe(signature);
    expect(
      scannerBlockContentSignature({
        ...input,
        sides: [
          { ...input.sides[0], engineId: 'audiveris-5' },
          { ...input.sides[1], engineId: 'homr' }
        ]
      })
    ).not.toBe(signature);
  });
});

describe('merged score basis', () => {
  const locator = (checksum: string) => ({
    bucket: 'd',
    objectKey: `o-${checksum}`,
    sizeBytes: 1,
    contentType: 'application/xml',
    checksumSha256: checksum
  });
  const run = (engine: string, checksum: string, status = 'succeeded') =>
    ({
      engine,
      status,
      attempts: 1,
      idempotencyKey: `k-${engine}`,
      artifacts: { musicXml: locator(checksum) }
    }) as any;

  const pageWithMerge = (engines: any, basisSignature: string) => ({
    engines,
    mergedMusicXml: locator('merged'),
    mergedScore: {
      sourceEngineId: 'homr',
      basisSignature,
      revision: 1,
      updatedAt: new Date()
    }
  });

  it('ignores the order engines happen to be recorded in', () => {
    // Insertion order is a worker detail. If it reached the signature, merely
    // re-running the pages in a different sequence would mark every merge stale.
    expect(
      scannerMergedScoreBasis({
        engines: { homr: run('homr', 'a'), transcoda: run('transcoda', 'b') }
      })
    ).toBe(
      scannerMergedScoreBasis({
        engines: { transcoda: run('transcoda', 'b'), homr: run('homr', 'a') }
      })
    );
  });

  it('follows the reviewed artifact, because that is what the comparison shows', () => {
    const raw = { engines: { homr: run('homr', 'a') } };
    const reviewed = {
      engines: { homr: { ...run('homr', 'a'), reviewedMusicXml: locator('a-reviewed') } }
    };
    expect(scannerMergedScoreBasis(reviewed)).not.toBe(scannerMergedScoreBasis(raw));
  });

  it('does not move when a failed engine retries', () => {
    // A failed engine contributed no reading, so nothing the merge answers has
    // changed and the reviewer should not be asked to re-examine it.
    const before = { engines: { homr: run('homr', 'a'), transcoda: run('transcoda', '', 'failed') } };
    const after = {
      engines: { homr: run('homr', 'a'), transcoda: run('transcoda', '', 'running') }
    };
    expect(scannerMergedScoreBasis(after)).toBe(scannerMergedScoreBasis(before));
  });

  it('marks a merge stale when a reading it answers is replaced', () => {
    const engines = { homr: run('homr', 'a'), transcoda: run('transcoda', 'b') };
    const page = pageWithMerge(engines, scannerMergedScoreBasis({ engines }));
    expect(scannerMergedScoreStale(page)).toBe(false);

    const rescanned = {
      ...page,
      engines: { homr: run('homr', 'a-rescanned'), transcoda: run('transcoda', 'b') }
    };
    expect(scannerMergedScoreStale(rescanned)).toBe(true);
  });

  it('keeps a stale merge but stops treating it as the page', () => {
    // Design 3.1: losing typed corrections to a background re-scan is the worst
    // failure this feature could have — but assembling from a merge that
    // answers readings which no longer exist is not the fix.
    const engines = { homr: run('homr', 'a') };
    const page: any = pageWithMerge(engines, scannerMergedScoreBasis({ engines }));
    expect(effectivePageMusicXml(page)?.checksumSha256).toBe('merged');
    expect(pageMusicXmlSuperseded(page)).toBe(true);

    const rescanned: any = { ...page, engines: { homr: run('homr', 'a-rescanned') } };
    expect(rescanned.mergedMusicXml).toBeDefined();
    expect(effectivePageMusicXml(rescanned)?.checksumSha256).toBe('a-rescanned');
    expect(pageMusicXmlSuperseded(rescanned)).toBe(false);
  });

  it('has no opinion about a page that was never merged', () => {
    expect(scannerMergedScoreStale({ engines: { homr: run('homr', 'a') } })).toBe(false);
  });
});
