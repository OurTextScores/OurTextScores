import { BadRequestException } from '@nestjs/common';
import { ScannerController } from './scanner.controller';

describe('ScannerController provider selection', () => {
  const user = { userId: 'user-1' } as any;
  const response = { setHeader: jest.fn() } as any;
  let scanner: { createJob: jest.Mock; listNewJobEngines: jest.Mock; pageReview: jest.Mock };
  let controller: ScannerController;

  beforeEach(() => {
    scanner = {
      createJob: jest.fn().mockResolvedValue({ jobId: 'job-1' }),
      listNewJobEngines: jest.fn().mockReturnValue({ items: [] }),
      pageReview: jest.fn().mockReturnValue({ engineId: 'ots-homr' })
    };
    controller = new ScannerController(scanner as any);
    response.setHeader.mockClear();
  });

  const create = (engineIds?: unknown, otsHomr?: unknown) =>
    controller.create(
      user,
      [],
      response,
      'false',
      engineIds === undefined ? undefined : JSON.stringify(engineIds),
      otsHomr === undefined ? undefined : JSON.stringify(otsHomr)
    );

  it.each<unknown>([undefined, [], ['homr', 'homr'], ['homr', 'transcoda', 'ots-homr']])(
    'rejects a job without one or two distinct providers: %p',
    async (engineIds) => {
      await expect(create(engineIds)).rejects.toBeInstanceOf(BadRequestException);
      expect(scanner.createJob).not.toHaveBeenCalled();
    }
  );

  it('passes a single selected provider', async () => {
    await create(['homr']);

    expect(scanner.createJob).toHaveBeenCalledWith(
      expect.objectContaining({ requestedEngineIds: ['homr'] })
    );
  });

  it('passes the selected pair in dropdown order', async () => {
    await create(['transcoda', 'homr']);

    expect(scanner.createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedEngineIds: ['transcoda', 'homr']
      })
    );
    expect(scanner.createJob.mock.calls[0][0].engineOptions).toBeUndefined();
    expect(response.setHeader).toHaveBeenCalledWith('Location', '/api/scanner/jobs/job-1');
  });

  it('requires OTS-HOMR options exactly when OTS-HOMR is selected', async () => {
    const options = { textDetector: 'lyrics' };
    await expect(create(['homr', 'ots-homr'])).rejects.toBeInstanceOf(BadRequestException);
    await expect(create(['homr', 'transcoda'], options)).rejects.toBeInstanceOf(
      BadRequestException
    );

    await create(['ots-homr'], options);
    expect(scanner.createJob).toHaveBeenLastCalledWith(
      expect.objectContaining({
        requestedEngineIds: ['ots-homr'],
        engineOptions: { 'ots-homr': options }
      })
    );

    await create(['ots-homr', 'transcoda'], options);
    expect(scanner.createJob).toHaveBeenLastCalledWith(
      expect.objectContaining({
        requestedEngineIds: ['ots-homr', 'transcoda'],
        engineOptions: { 'ots-homr': options }
      })
    );
  });

  it('exposes only the service-provided safe selector metadata', () => {
    controller.engines(user);
    expect(scanner.listNewJobEngines).toHaveBeenCalledWith('user-1');
  });

  it('requests review for the selected engine instead of silently choosing the first', () => {
    controller.review(user, 'job-1', 3, 'ots-homr');
    expect(scanner.pageReview).toHaveBeenCalledWith('user-1', 'job-1', 3, 'ots-homr', undefined);
  });

  it('passes an explicit review group through to the scanner service', () => {
    controller.review(user, 'job-1', 3, 'ots-homr', 'stem');
    expect(scanner.pageReview).toHaveBeenCalledWith('user-1', 'job-1', 3, 'ots-homr', 'stem');
  });
});
