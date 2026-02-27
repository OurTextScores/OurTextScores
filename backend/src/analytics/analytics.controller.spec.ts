import { BadRequestException } from '@nestjs/common';
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
    getCatalogStats: jest.fn()
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

  it('delegates funnel/retention/catalog endpoints', async () => {
    analyticsService.getFunnel.mockResolvedValue({} as any);
    analyticsService.getRetention.mockResolvedValue({} as any);
    analyticsService.getCatalogStats.mockResolvedValue({} as any);

    await controller.getFunnel();
    await controller.getRetention();
    await controller.getCatalog();

    expect(analyticsService.getFunnel).toHaveBeenCalled();
    expect(analyticsService.getRetention).toHaveBeenCalled();
    expect(analyticsService.getCatalogStats).toHaveBeenCalled();
  });
});
