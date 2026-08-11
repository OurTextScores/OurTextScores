import { ScannerAlertService } from './scanner-alert.service';

describe('ScannerAlertService', () => {
  const values: Record<string, string> = {};
  const config = {
    get: jest.fn((key: string, fallback?: string) => values[key] ?? fallback)
  } as any;

  /** `find()` is used twice per evaluation: oldest queued, then recent jobs. */
  function jobsWith(options: { queuedAt?: Date; pages?: any[] } = {}) {
    const queued = options.queuedAt ? [{ queuedAt: options.queuedAt }] : [];
    return {
      find: jest.fn((filter: any) =>
        filter?.status === 'queued'
          ? { sort: () => ({ limit: () => ({ lean: () => ({ exec: async () => queued }) }) }) }
          : {
              select: () => ({
                lean: () => ({ exec: async () => [{ pages: options.pages ?? [] }] })
              })
            }
      )
    } as any;
  }

  beforeEach(() => {
    for (const key of Object.keys(values)) delete values[key];
    jest.restoreAllMocks();
  });

  it('is quiet when nothing is wrong', async () => {
    const service = new ScannerAlertService(jobsWith(), config);
    await expect(service.evaluate()).resolves.toEqual([]);
  });

  it('reports a disabled provider', async () => {
    const service = new ScannerAlertService(jobsWith(), config);
    const alerts = await service.evaluate('CUDA expected but absent');
    expect(alerts.map((a) => a.key)).toEqual(['provider_disabled:homr']);
    expect(alerts[0].message).toContain('CUDA expected but absent');
  });

  it('reports disabled providers independently', async () => {
    const service = new ScannerAlertService(jobsWith(), config);
    const alerts = await service.evaluate({ homr: 'CUDA absent', 'audiveris-5': 'bad revision' });
    expect(alerts.map((a) => a.key)).toEqual([
      'provider_disabled:homr',
      'provider_disabled:audiveris-5'
    ]);
  });

  it('reports an operator stop that was left engaged', async () => {
    // Set by hand and stays set, so it is exactly what gets forgotten after the
    // budget is raised — and the only other symptom is the scanner quietly
    // refusing every job.
    values.SCANNER_PROVIDER_BUDGET_EXHAUSTED = 'true';
    const service = new ScannerAlertService(jobsWith(), config);
    const alerts = await service.evaluate();
    expect(alerts.map((a) => a.key)).toEqual(['budget_stop_engaged:homr']);
    delete values.SCANNER_PROVIDER_BUDGET_EXHAUSTED;
  });

  it('reports a job that has sat in the queue', async () => {
    const service = new ScannerAlertService(
      jobsWith({ queuedAt: new Date(Date.now() - 20 * 60_000) }),
      config
    );
    const alerts = await service.evaluate();
    expect(alerts.map((a) => a.key)).toContain('queue_stalled');
    expect(alerts[0].message).toMatch(/20 minutes/);
  });

  it('needs a minimum sample before calling a failure rate', async () => {
    // One failure in three is 33%, but three pages is not evidence.
    const few = [
      { status: 'failed', errorCode: 'provider_timeout' },
      { status: 'succeeded' },
      { status: 'succeeded' }
    ];
    await expect(
      new ScannerAlertService(jobsWith({ pages: few }), config).evaluate()
    ).resolves.toEqual([]);

    const many = [
      ...Array.from({ length: 4 }, () => ({
        status: 'failed',
        errorCode: 'provider_no_staff_detected'
      })),
      ...Array.from({ length: 8 }, () => ({ status: 'succeeded' }))
    ];
    const alerts = await new ScannerAlertService(jobsWith({ pages: many }), config).evaluate();
    expect(alerts.map((a) => a.key)).toEqual(['page_failure_rate:homr']);
    // Naming the dominant cause is what makes the alert actionable.
    expect(alerts[0].message).toContain('provider_no_staff_detected');
    expect(alerts[0].message).toContain('4 of 12');
  });

  it('alerts when HOMR fails behind successful aggregate pages', async () => {
    const rescued = Array.from({ length: 12 }, () => ({
      status: 'succeeded',
      engines: {
        homr: {
          status: 'failed',
          errorCode: 'provider_http_503'
        },
        transcoda: { status: 'succeeded' }
      }
    }));
    const alerts = await new ScannerAlertService(jobsWith({ pages: rescued }), config).evaluate();
    expect(alerts).toEqual([
      expect.objectContaining({
        key: 'page_failure_rate:homr',
        message: expect.stringMatching(/12 of 12.*provider_http_503/)
      })
    ]);
  });

  it('alerts on a third engine degrading behind successful HOMR pages', async () => {
    const pages = Array.from({ length: 12 }, () => ({
      status: 'succeeded',
      engines: {
        homr: { status: 'succeeded', attempts: 1, artifacts: {} },
        'audiveris-5': {
          status: 'failed',
          attempts: 1,
          errorCode: 'provider_http_503',
          artifacts: {}
        }
      }
    }));
    const alerts = await new ScannerAlertService(jobsWith({ pages }), config).evaluate();
    expect(alerts).toEqual([
      expect.objectContaining({
        key: 'page_failure_rate:audiveris-5',
        message: expect.stringMatching(/audiveris-5: 12 of 12.*provider_http_503/)
      })
    ]);
  });

  it('reports per-engine operator budget stops from the registry', async () => {
    values.SCANNER_AUDIVERIS_BUDGET_EXHAUSTED = 'true';
    const registry = {
      allDefinitions: () => [
        {
          id: 'audiveris-5',
          budgetExhaustedConfigKey: 'SCANNER_AUDIVERIS_BUDGET_EXHAUSTED'
        }
      ]
    } as any;
    const alerts = await new ScannerAlertService(jobsWith(), config, registry).evaluate();
    expect(alerts).toEqual([expect.objectContaining({ key: 'budget_stop_engaged:audiveris-5' })]);
  });

  it('fires once, then again only after the cooldown, then reports recovery', async () => {
    values.SCANNER_ALERT_WEBHOOK_URL = 'https://hooks.example/abc';
    values.SCANNER_ALERT_COOLDOWN_MS = '3600000';
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    const stalled = jobsWith({ queuedAt: new Date(Date.now() - 20 * 60_000) });
    const service = new ScannerAlertService(stalled, config);

    expect((await service.check()).map((a) => a.key)).toEqual(['queue_stalled']);
    // Still firing, but inside the cooldown: no second notification.
    expect(await service.check()).toEqual([]);

    // Condition clears; the operator is told, once.
    (service as any).jobs = jobsWith();
    expect(await service.check()).toEqual([]);
    const bodies = fetchSpy.mock.calls.map(([, init]) => String((init as any)?.body));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain('queued for 20 minutes');
    expect(bodies[1]).toContain('has cleared');
    // Discord takes `content`, Slack takes `text`; both are sent.
    expect(JSON.parse(bodies[0])).toMatchObject({
      content: expect.any(String),
      text: expect.any(String)
    });
  });

  it('never lets a webhook failure escape into the scan path', async () => {
    values.SCANNER_ALERT_WEBHOOK_URL = 'https://hooks.example/abc';
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));
    const service = new ScannerAlertService(
      jobsWith({ queuedAt: new Date(Date.now() - 20 * 60_000) }),
      config
    );
    await expect(service.check()).resolves.toHaveLength(1);
  });

  it('still logs conditions when no webhook is configured', async () => {
    const service = new ScannerAlertService(
      jobsWith({ queuedAt: new Date(Date.now() - 20 * 60_000) }),
      config
    );
    expect(service.enabled).toBe(false);
    const fetchSpy = jest.spyOn(global, 'fetch');
    await expect(service.check()).resolves.toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
