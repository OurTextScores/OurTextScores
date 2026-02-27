import { BadRequestException, HttpException } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

describe('AnalyticsController', () => {
  const analyticsService = {
    toActor: jest.fn(),
    getRequestContext: jest.fn(),
    ingest: jest.fn(),
    getOverview: jest.fn(),
    getTimeseries: jest.fn(),
    getFunnel: jest.fn(),
    getRetention: jest.fn(),
    getScoreEditorMetrics: jest.fn(),
    getCatalogStats: jest.fn(),
    backfillDailyRollups: jest.fn()
  } as any as jest.Mocked<AnalyticsService>;

  const controller = new AnalyticsController(analyticsService);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('ingestEvents delegates to AnalyticsService', async () => {
    analyticsService.toActor.mockReturnValue({ userId: 'u1', roles: ['user'] });
    analyticsService.getRequestContext.mockReturnValue({ sourceApp: 'frontend', route: '/api/analytics/events' });
    analyticsService.ingest.mockResolvedValue({ accepted: 1 });

    const req = { originalUrl: '/api/analytics/events', headers: {} } as any;
    const result = await controller.ingestEvents({ eventName: 'score_viewed' }, { userId: 'u1' } as any, req);

    expect(analyticsService.ingest).toHaveBeenCalled();
    expect(result).toEqual({ ok: true, accepted: 1 });
  });

  it('ingestEvents applies anonymous rate limiting by event count', async () => {
    analyticsService.toActor.mockReturnValue({});
    analyticsService.getRequestContext.mockReturnValue({ sourceApp: 'frontend', route: '/api/analytics/events' });

    const req = { originalUrl: '/api/analytics/events', headers: { 'x-forwarded-for': '203.0.113.9' } } as any;
    const events = Array.from({ length: 121 }, () => ({ eventName: 'score_viewed' }));

    try {
      await controller.ingestEvents({ events }, undefined, req);
      fail('Expected ingestEvents to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);
    }
    expect(analyticsService.ingest).not.toHaveBeenCalled();
  });

  it('getOverview rejects invalid from date', async () => {
    await expect(controller.getOverview('bad-date', undefined, undefined)).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('getTimeseries normalizes bucket', async () => {
    analyticsService.getTimeseries.mockResolvedValue({ ok: true } as any);

    await controller.getTimeseries(undefined, undefined, undefined, 'America/New_York', 'invalid');

    expect(analyticsService.getTimeseries).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'day', timezone: 'America/New_York' })
    );
  });

  it('getEditorMetrics normalizes bucket', async () => {
    analyticsService.getScoreEditorMetrics.mockResolvedValue({ ok: true } as any);

    await controller.getEditorMetrics(undefined, undefined, undefined, 'America/New_York', 'invalid');

    expect(analyticsService.getScoreEditorMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'day', timezone: 'America/New_York' })
    );
  });

  it('delegates funnel/retention/catalog endpoints', async () => {
    analyticsService.getFunnel.mockResolvedValue({} as any);
    analyticsService.getRetention.mockResolvedValue({} as any);
    analyticsService.getScoreEditorMetrics.mockResolvedValue({} as any);
    analyticsService.getCatalogStats.mockResolvedValue({} as any);

    await controller.getFunnel();
    await controller.getRetention();
    await controller.getEditorMetrics();
    await controller.getCatalog();

    expect(analyticsService.getFunnel).toHaveBeenCalled();
    expect(analyticsService.getRetention).toHaveBeenCalled();
    expect(analyticsService.getScoreEditorMetrics).toHaveBeenCalled();
    expect(analyticsService.getCatalogStats).toHaveBeenCalled();
  });

  it('backfillRollups delegates to analytics service', async () => {
    analyticsService.backfillDailyRollups.mockResolvedValue({
      timezone: 'America/New_York',
      updated: 2,
      totalDays: 2
    } as any);

    const result = await controller.backfillRollups(
      '2026-02-01T00:00:00.000Z',
      '2026-02-03T00:00:00.000Z',
      'America/New_York'
    );

    expect(analyticsService.backfillDailyRollups).toHaveBeenCalledWith({
      from: new Date('2026-02-01T00:00:00.000Z'),
      to: new Date('2026-02-03T00:00:00.000Z'),
      timezone: 'America/New_York'
    });
    expect(result).toEqual({
      timezone: 'America/New_York',
      updated: 2,
      totalDays: 2
    });
  });
});
