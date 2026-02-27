import { BadRequestException } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';

describe('AnalyticsService', () => {
  const insertMany = jest.fn();
  const create = jest.fn();
  const aggregateExec = jest.fn();
  const aggregate = jest.fn(() => ({ exec: aggregateExec }));
  const findExec = jest.fn();
  const find = jest.fn(() => ({ lean: () => ({ exec: findExec }) }));

  const analyticsModel = {
    insertMany,
    create,
    aggregate,
    find
  } as any;

  const countDocumentsExec = jest.fn();
  const countDocuments = jest.fn(() => ({ exec: countDocumentsExec }));
  const workModel = { countDocuments } as any;
  const sourceModel = { countDocuments } as any;
  const sourceRevisionModel = { countDocuments } as any;

  const service = new AnalyticsService(
    analyticsModel,
    workModel,
    sourceModel,
    sourceRevisionModel
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('ingest rejects unsupported event names', async () => {
    await expect(
      service.ingest(
        { eventName: 'bad_event' },
        { userId: 'u1', roles: ['user'] },
        { sourceApp: 'frontend' }
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ingest stores admin events with includeInBusinessMetrics=false', async () => {
    insertMany.mockResolvedValue([]);

    await service.ingest(
      {
        eventName: 'score_viewed',
        properties: { work_id: 'w1' }
      },
      { userId: 'admin-id', roles: ['admin'] },
      {
        sourceApp: 'backend',
        requestId: 'req-1',
        route: '/api/works/w1'
      }
    );

    expect(insertMany).toHaveBeenCalledTimes(1);
    const inserted = insertMany.mock.calls[0][0][0];
    expect(inserted.eventName).toBe('score_viewed');
    expect(inserted.userRole).toBe('admin');
    expect(inserted.includeInBusinessMetrics).toBe(false);
    expect(inserted.requestId).toBe('req-1');
    expect(inserted.properties).toEqual({
      work_id: 'w1',
      source_id: null,
      revision_id: null,
      view_surface: 'unknown'
    });
  });

  it('ingest treats public ingest as untrusted and ignores source override', async () => {
    insertMany.mockResolvedValue([]);

    await service.ingest(
      {
        eventName: 'score_downloaded',
        sourceApp: 'score_editor_api',
        requestId: 'spoofed-id',
        properties: {
          work_id: 'w1',
          file_format: 'application/pdf'
        }
      },
      { userId: 'u1', roles: ['user'] },
      {
        sourceApp: 'frontend',
        requestId: 'req-real',
        route: '/api/analytics/events'
      },
      { trustedIngest: false }
    );

    const inserted = insertMany.mock.calls[0][0][0];
    expect(inserted.sourceApp).toBe('frontend');
    expect(inserted.requestId).toBe('req-real');
    expect(inserted.properties.file_format).toBe('pdf');
  });

  it('ingest rejects stale eventTime from untrusted sources', async () => {
    const oldDate = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString();
    await expect(
      service.ingest(
        { eventName: 'score_viewed', eventTime: oldDate },
        {},
        { sourceApp: 'frontend' },
        { trustedIngest: false }
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ingest rejects disallowed event names for untrusted payloads', async () => {
    await expect(
      service.ingest(
        { eventName: 'revision_rated', properties: { revision_id: 'r1', rating_value: 5 } },
        { userId: 'u1', roles: ['user'] },
        { sourceApp: 'frontend' },
        { trustedIngest: false }
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('trackFirstScoreLoadedIfNeeded returns false on duplicate-key and true on first write', async () => {
    create.mockResolvedValueOnce({});
    create.mockRejectedValueOnce({ code: 11000 });

    await expect(
      service.trackFirstScoreLoadedIfNeeded({
        actor: { userId: 'u1', roles: ['user'] },
        requestContext: { sourceApp: 'backend' },
        entryType: 'existing',
        workId: 'w1'
      })
    ).resolves.toBe(true);

    await expect(
      service.trackFirstScoreLoadedIfNeeded({
        actor: { userId: 'u1', roles: ['user'] },
        requestContext: { sourceApp: 'backend' },
        entryType: 'existing',
        workId: 'w1'
      })
    ).resolves.toBe(false);
  });

  it('getTimeseries returns bucketed points and engagement uniques', async () => {
    aggregateExec.mockResolvedValue([
      {
        bucketStart: new Date('2026-02-01T00:00:00Z'),
        wae: 1,
        wacu: 1,
        weu: 2,
        newSignups: 0,
        uploadsSuccess: 1,
        revisionsSaved: 0,
        searches: 0,
        views: 1,
        comments: 0,
        ratings: 0,
        downloads: 1
      },
    ]);

    const result = await service.getTimeseries({
      from: new Date('2026-02-01T00:00:00Z'),
      to: new Date('2026-02-03T00:00:00Z'),
      timezone: 'America/New_York',
      bucket: 'day'
    });

    expect(result.points.length).toBeGreaterThanOrEqual(2);
    const day = result.points.find((point) => point.uploadsSuccess === 1)!;
    expect(day.wae).toBe(1);
    expect(day.wacu).toBe(1);
    expect(day.weu).toBe(2);
    expect(day.downloads).toBe(1);
  });

  it('getCatalogStats returns totals and range additions', async () => {
    countDocumentsExec
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(20)
      .mockResolvedValueOnce(30)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(6);

    const result = await service.getCatalogStats({
      from: new Date('2026-02-01T00:00:00Z'),
      to: new Date('2026-02-10T00:00:00Z')
    });

    expect(result.totals).toEqual({ works: 10, sources: 20, revisions: 30 });
    expect(result.newInRange).toEqual({ works: 2, sources: 4, revisions: 6 });
  });

  it('getFunnel returns deterministic step counts', async () => {
    findExec.mockResolvedValue([
      { eventName: 'signup_completed', eventTime: new Date('2026-02-01T00:00:00Z'), userId: 'u1', properties: {} },
      { eventName: 'first_score_loaded', eventTime: new Date('2026-02-02T00:00:00Z'), userId: 'u1', properties: {} },
      { eventName: 'editor_revision_saved', eventTime: new Date('2026-02-03T00:00:00Z'), userId: 'u1', properties: {} },
      { eventName: 'score_viewed', eventTime: new Date('2026-02-11T00:00:00Z'), userId: 'u1', properties: {} },
      { eventName: 'signup_completed', eventTime: new Date('2026-02-01T00:00:00Z'), userId: 'u2', properties: {} }
    ]);

    const result = await service.getFunnel({
      from: new Date('2026-02-01T00:00:00Z'),
      to: new Date('2026-02-20T00:00:00Z')
    });

    expect(result.steps[0].count).toBe(2);
    expect(result.steps[1].count).toBe(1);
    expect(result.steps[2].count).toBe(1);
    expect(result.steps[3].count).toBe(1);
  });

  it('getRequestContext prefers explicit session headers', () => {
    const request = {
      headers: {
        'x-client-session-id': 'session-header-123',
        'x-request-id': 'req-1'
      },
      originalUrl: '/api/works/1'
    } as any;

    const context = service.getRequestContext(request, { sourceApp: 'frontend' });

    expect(context.sessionId).toBe('session-header-123');
    expect(context.requestId).toBe('req-1');
    expect(context.route).toBe('/api/works/1');
  });

  it('getRequestContext falls back to ots_session_id cookie when session headers are missing', () => {
    const request = {
      headers: {
        cookie: 'foo=bar; ots_session_id=session-cookie-abc; another=value'
      },
      url: '/api/analytics/events'
    } as any;

    const context = service.getRequestContext(request, { sourceApp: 'frontend' });

    expect(context.sessionId).toBe('session-cookie-abc');
    expect(context.route).toBe('/api/analytics/events');
  });
});
