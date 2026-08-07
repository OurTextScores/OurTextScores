import { Logger } from '@nestjs/common';
import { ScannerTelemetryService } from './scanner-telemetry.service';

describe('ScannerTelemetryService', () => {
  const values: Record<string, string> = {};
  const config = {
    get: jest.fn((key: string, fallback?: string) => values[key] ?? fallback)
  } as any;
  let logged: string[];

  beforeEach(() => {
    logged = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message: any) => {
      logged.push(String(message));
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: any) => {
      logged.push(String(message));
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('emits a single parseable line with only the allow-listed fields', () => {
    new ScannerTelemetryService(config).emit('page_succeeded', {
      jobId: 'job-1',
      pageNumber: 3,
      userHash: 'abc123',
      providerMs: 5400,
      outputBytes: 2048
    });
    expect(logged).toHaveLength(1);
    const payload = JSON.parse(logged[0].replace(/^scanner /, ''));
    expect(payload).toEqual({
      event: 'page_succeeded',
      jobId: 'job-1',
      pageNumber: 3,
      userHash: 'abc123',
      providerMs: 5400,
      outputBytes: 2048
    });
  });

  it('cannot log score content, filenames, or credentials even if handed them', () => {
    // The allow-list is the enforcement point: call sites cannot leak by
    // accident, which is the design section 13.4 "never log" list.
    new ScannerTelemetryService(config).emit('page_failed', {
      jobId: 'job-1',
      errorCode: 'provider_http_503',
      ...({
        originalFilename: 'Chopin - Nocturne (personal scan).pdf',
        musicXml: '<score-partwise/>',
        authorization: 'Bearer super-secret',
        signedUrl: 'https://minio.example/scanner/x?X-Amz-Signature=abc'
      } as any)
    });
    const line = logged[0];
    expect(line).not.toContain('Nocturne');
    expect(line).not.toContain('score-partwise');
    expect(line).not.toContain('super-secret');
    expect(line).not.toContain('X-Amz-Signature');
    expect(JSON.parse(line.replace(/^scanner /, ''))).toEqual({
      event: 'page_failed',
      jobId: 'job-1',
      errorCode: 'provider_http_503'
    });
  });

  it('omits empty values rather than logging nulls', () => {
    new ScannerTelemetryService(config).emit('job_created', {
      jobId: 'job-1',
      providerRevision: '',
      pageCount: undefined,
      errorCode: undefined
    });
    expect(JSON.parse(logged[0].replace(/^scanner /, ''))).toEqual({
      event: 'job_created',
      jobId: 'job-1'
    });
  });

  it('hashes the owner and never emits the raw user id', () => {
    values.SCANNER_OBJECT_KEY_SALT = 'deployment-salt';
    const telemetry = new ScannerTelemetryService(config);
    const hash = telemetry.userHash('507f1f77bcf86cd799439011');
    expect(hash).not.toContain('507f1f77bcf86cd799439011');
    telemetry.emit('job_created', { jobId: 'job-1', userHash: hash });
    expect(logged[0]).not.toContain('507f1f77bcf86cd799439011');
    delete values.SCANNER_OBJECT_KEY_SALT;
  });

  it('never fails a scan when analytics is unavailable', async () => {
    // finish() awaits trackJobFinished, so a throw here would skip the terminal
    // notification and send a completed job down the error path.
    const analytics = {
      trackBestEffort: jest.fn().mockRejectedValue(new Error('mongo down'))
    } as any;
    const telemetry = new ScannerTelemetryService(config, analytics);

    await expect(
      telemetry.trackJobCreated({
        userId: 'user-1',
        pageCount: 2,
        inputContentType: 'application/pdf'
      })
    ).resolves.toBeUndefined();
    await expect(
      telemetry.trackJobFinished({
        userId: 'user-1',
        status: 'succeeded',
        pageCount: 2,
        succeededPages: 2,
        failedPages: 0
      })
    ).resolves.toBeUndefined();
    expect(analytics.trackBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: 'scanner_job_created' })
    );
  });

  it('works with no analytics service at all, as in the worker process', async () => {
    const telemetry = new ScannerTelemetryService(config);
    await expect(
      telemetry.trackJobFinished({
        userId: 'user-1',
        status: 'partial',
        pageCount: 2,
        succeededPages: 1,
        failedPages: 1
      })
    ).resolves.toBeUndefined();
  });
});
