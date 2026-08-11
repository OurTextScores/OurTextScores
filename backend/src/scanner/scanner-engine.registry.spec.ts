import { ScannerEngineRegistry, ScannerEngineDefinition } from './scanner-engine.registry';

describe('ScannerEngineRegistry', () => {
  const values: Record<string, string> = {};
  const config = { get: (key: string, fallback?: string) => values[key] ?? fallback } as any;
  const homr = { engine: 'homr' } as any;
  const transcoda = { engine: 'transcoda' } as any;

  beforeEach(() => {
    delete values.SCANNER_TRANSCODA_ENABLED;
    delete values.SCANNER_PROVIDER_BUDGET_EXHAUSTED;
    delete values.SCANNER_TRANSCODA_PROVIDER_BUDGET_EXHAUSTED;
  });

  it('snapshots only engines enabled when a new job is created', () => {
    const registry = new ScannerEngineRegistry(config, homr, transcoda);
    expect(registry.newJobPlan().engineIds).toEqual(['homr']);
    expect(registry.get('homr')?.measureGeometryProducer).toEqual(expect.any(Function));
    expect(registry.get('transcoda')?.measureGeometryProducer).toBeUndefined();

    values.SCANNER_TRANSCODA_ENABLED = 'true';
    expect(registry.newJobPlan()).toMatchObject({
      engineIds: ['homr', 'transcoda'],
      primaryEngineId: 'homr',
      fallbackEngineIds: ['transcoda']
    });
    values.SCANNER_PROVIDER_BUDGET_EXHAUSTED = 'true';
    expect(registry.newJobCapacityExhausted()).toBe(false);
    values.SCANNER_TRANSCODA_PROVIDER_BUDGET_EXHAUSTED = 'true';
    expect(registry.newJobCapacityExhausted()).toBe(true);
  });

  it('adds a third adapter through one definition and preserves it in legacy inference', () => {
    const registry = new ScannerEngineRegistry(config, homr, transcoda);
    const audiveris: ScannerEngineDefinition = {
      id: 'audiveris-5',
      displayName: 'Audiveris 5',
      adapter: { engine: 'audiveris-5' } as any,
      readable: true,
      enabledForNewJobs: () => true,
      budgetExhaustedConfigKey: 'SCANNER_AUDIVERIS_BUDGET_EXHAUSTED',
      providerKindConfigKey: 'SCANNER_AUDIVERIS_PROVIDER_KIND',
      timeoutConfigKey: 'SCANNER_AUDIVERIS_TIMEOUT_MS',
      capabilities: {
        displayName: 'Audiveris 5',
        outputArtifactKinds: ['musicxml', 'mei'],
        supportsSpotReview: false,
        supportsMeasureGeometry: true,
        unsupportedSemanticClasses: []
      },
      artifacts: {
        musicxml: {
          contentType: 'application/vnd.recordare.musicxml+xml',
          extension: 'musicxml',
          maxBytes: 10_485_760,
          requiredProviderOutput: true
        },
        mei: {
          contentType: 'application/mei+xml',
          extension: 'mei',
          maxBytes: 10_485_760,
          requiredProviderOutput: true
        }
      }
    };
    registry.register(audiveris);

    expect(registry.newJobPlan().engineIds).toEqual(['homr', 'audiveris-5']);
    expect(registry.readable('audiveris-5')).toMatchObject(audiveris);
    expect(registry.planForJob({ pages: [] }).capabilitySnapshots['audiveris-5']).toEqual(
      audiveris.capabilities
    );
  });

  it('rejects duplicate IDs and mismatched artifact declarations', () => {
    const registry = new ScannerEngineRegistry(config, homr, transcoda);
    expect(() =>
      registry.register({
        ...(registry.get('homr') as ScannerEngineDefinition),
        adapter: homr
      })
    ).toThrow('Invalid or duplicate');
    expect(() =>
      registry.register({
        ...(registry.get('transcoda') as ScannerEngineDefinition),
        id: 'broken',
        displayName: 'Broken',
        adapter: { engine: 'broken' } as any,
        capabilities: {
          ...(registry.get('transcoda') as ScannerEngineDefinition).capabilities,
          displayName: 'Broken',
          outputArtifactKinds: ['musicxml']
        }
      })
    ).toThrow('artifact contract mismatch');
  });
});
