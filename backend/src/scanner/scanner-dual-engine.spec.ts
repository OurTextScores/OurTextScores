import {
  SCANNER_ARTIFACT_BUILDERS,
  scannerArtifactInputSignature,
  scannerArtifactInputMatches,
  scannerAggregatePageStatus,
  scannerBlockContentSignature,
  scannerEngineArtifactLocators,
  scannerHomrRun,
  uniqueScannerStorageLocators,
  withScannerArtifactInputSignature,
  withScannerHomrRun
} from './scanner-dual-engine';
import { scannerProviderIdempotencyKey } from './scanner-provider.contract';

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
    const run = (engine: 'homr' | 'transcoda', status: any): any => ({
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
    const input = {
      homrArtifactChecksumSha256: 'homr-v1',
      transcodaArtifactChecksumSha256: 'transcoda-v1',
      partMatchVersion: 'part-match-v1',
      descriptorVersion: 'measure-descriptor-v1',
      stablePartKey: 'part-1',
      homrDescriptorHashes: ['homr-m1'],
      transcodaDescriptorHashes: ['transcoda-m1'],
      contextBeforeHash: 'before',
      contextAfterHash: 'after'
    };
    const signature = scannerBlockContentSignature(input);

    expect(signature).toMatch(/^scanner-block-content-v1:[a-f0-9]{64}$/);
    expect(scannerBlockContentSignature(input)).toBe(signature);
    expect(
      scannerBlockContentSignature({
        ...input,
        homrArtifactChecksumSha256: 'homr-after-spot-correction'
      })
    ).not.toBe(signature);
    expect(
      scannerBlockContentSignature({
        ...input,
        transcodaDescriptorHashes: ['transcoda-m1-different-reading']
      })
    ).not.toBe(signature);
  });
});
