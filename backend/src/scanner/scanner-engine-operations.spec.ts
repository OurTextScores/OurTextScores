import { scannerEngineOperationalMetrics } from './scanner-engine-operations';

describe('scannerEngineOperationalMetrics', () => {
  it('keeps independent metrics for legacy HOMR and any recorded engines', () => {
    const metrics = scannerEngineOperationalMetrics([
      {
        pages: [
          {
            status: 'succeeded',
            attempts: 2,
            durationMs: 5000,
            pdf: {},
            engines: {
              'audiveris-5': {
                status: 'failed',
                providerAttempts: 1,
                durationMs: 3000,
                errorCode: 'provider_http_503',
                artifacts: {}
              }
            }
          },
          {
            status: 'succeeded',
            attempts: 1,
            engines: {
              homr: { status: 'failed', attempts: 1, errorCode: 'homr_down', artifacts: {} },
              'audiveris-5': {
                status: 'succeeded',
                attempts: 1,
                durationMs: 2000,
                artifacts: { musicXml: {} }
              }
            }
          }
        ]
      }
    ]);

    expect(metrics.homr).toMatchObject({
      pagesByStatus: { succeeded: 1, failed: 1 },
      failureRate: 0.5,
      failuresByCode: { homr_down: 1 },
      pageLatencyMs: { samples: 1, p50: 5000 },
      renderSuccessRate: 1,
      provider: { calls: 3, approximateSeconds: 5 }
    });
    expect(metrics['audiveris-5']).toMatchObject({
      pagesByStatus: { succeeded: 1, failed: 1 },
      failureRate: 0.5,
      failuresByCode: { provider_http_503: 1 },
      provider: { calls: 2, approximateSeconds: 5 }
    });
  });

  it('does not invent a HOMR run when the persisted plan excludes it', () => {
    const metrics = scannerEngineOperationalMetrics([
      {
        enginePlan: { engineIds: ['audiveris-5'] },
        pages: [
          {
            status: 'succeeded',
            durationMs: 9000,
            engines: {
              'audiveris-5': {
                status: 'succeeded',
                attempts: 1,
                durationMs: 2000,
                artifacts: { musicXml: {} }
              }
            }
          }
        ]
      }
    ]);

    expect(metrics.homr).toBeUndefined();
    expect(metrics['audiveris-5'].pagesByStatus.succeeded).toBe(1);
  });
});
