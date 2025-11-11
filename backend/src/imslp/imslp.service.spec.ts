import { ImslpService } from './imslp.service';
import type { Model } from 'mongoose';
import { ImslpWork } from './schemas/imslp-work.schema';
import { execFile } from 'node:child_process';

// Simple chain helper
function chain<T>(result: T) {
  return { limit: jest.fn().mockReturnThis(), lean: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue(result) } as any;
}

jest.mock('node:child_process', () => ({
  ...jest.requireActual('node:child_process'),
  execFile: jest.fn(),
}));

// Get typed mock
const mockedExecFile = jest.mocked(execFile);

describe('ImslpService (unit, mocked model)', () => {
  let service: ImslpService;
  const model = {
    find: jest.fn(),
    findOne: jest.fn(),
    updateOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
  } as any as jest.Mocked<Model<ImslpWork>> & any;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new ImslpService(model as any);

    // Default: execFile returns an error (caught by service and returns null)
    // Handle both 3-arg (file, args, callback) and 4-arg (file, args, options, callback) signatures
    mockedExecFile.mockImplementation((file, args, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      if (cb && typeof cb === 'function') {
        setImmediate(() => {
          cb(new Error('Mock external call prevented'), '', '');
        });
      }
      return undefined as any;
    });
  });

  it('search returns mapped DTOs', async () => {
    const docs = [
      { workId: '123', title: 'Symphony', composer: 'X', permalink: 'https://imslp.org/wiki/123', metadata: { basic_info: { page_id: 123, page_title: 'Symphony' } } }
    ];
    (model.find as jest.Mock).mockReturnValue(chain(docs));
    const result = await service.search('Sym', 5);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ workId: '123', title: 'Symphony' });
  });

  it('search returns empty array for empty query', async () => {
    const result = await service.search('  ', 5);
    expect(result).toHaveLength(0);
    expect(model.find).not.toHaveBeenCalled();
  });

  it('search returns empty array when no results found', async () => {
    (model.find as jest.Mock).mockReturnValue(chain([]));
    const result = await service.search('NonExistent', 5);
    expect(result).toHaveLength(0);
  });

  it('ensureByWorkId returns cached metadata DTO', async () => {
    const doc = { workId: '200', title: 'T', composer: 'C', permalink: 'https://imslp.org/wiki/200', metadata: { basic_info: { page_id: 200, page_title: 'T' } } };
    (model.findOne as jest.Mock).mockReturnValue({ lean: () => ({ exec: () => Promise.resolve(doc) }) });
    const res = await service.ensureByWorkId('200');
    expect(res.workId).toBe('200');
    expect(res.metadata).toMatchObject({ workId: '200', title: 'T', composer: 'C' });
  });

  it('ensureByWorkId throws NotFoundException when work not found', async () => {
    (model.findOne as jest.Mock).mockReturnValue({ lean: () => ({ exec: () => Promise.resolve(null) }) });
    await expect(service.ensureByWorkId('999')).rejects.toThrow('IMSLP metadata not found for work 999');
  });

  it('ensureByPermalink returns cached metadata DTO', async () => {
    const doc = { workId: '300', title: 'Concerto', composer: 'Y', permalink: 'https://imslp.org/wiki/Concerto', metadata: { basic_info: { page_id: 300, page_title: 'Concerto' } } };
    (model.findOne as jest.Mock).mockReturnValue({ lean: () => ({ exec: () => Promise.resolve(doc) }) });
    const res = await service.ensureByPermalink('https://imslp.org/wiki/Concerto');
    expect(res.workId).toBe('300');
    expect(res.metadata).toMatchObject({ workId: '300', title: 'Concerto', composer: 'Y' });
  });

  it('ensureByPermalink fetches from MediaWiki when not in DB', async () => {
    const mockDoc = {
      workId: '400',
      title: 'Sonata',
      composer: 'Z',
      permalink: 'https://imslp.org/wiki/Sonata',
      metadata: { id: 400, title: 'Sonata', composer: 'Z', basic_info: { page_id: 400, page_title: 'Sonata' }, intvals: { pageid: 400, worktitle: 'Sonata' } }
    };

    (model.findOne as jest.Mock).mockReturnValue({ lean: () => ({ exec: () => Promise.resolve(null) }) });
    (model.findOneAndUpdate as jest.Mock).mockReturnValue({ lean: () => ({ exec: () => Promise.resolve(mockDoc) }) });

    // Spy on the private fetchFromMediaWiki method to return the doc
    jest.spyOn(service as any, 'fetchFromMediaWiki').mockResolvedValue(mockDoc);

    const res = await service.ensureByPermalink('https://imslp.org/wiki/Sonata');
    expect(res.workId).toBe('400');
    expect(res.metadata).toMatchObject({ workId: '400', title: 'Sonata', composer: 'Z' });
  });

  it('ensureByPermalink enriches when basic_info missing', async () => {
    const docWithoutBasicInfo = {
      workId: '500',
      title: 'Prelude',
      composer: 'Bach',
      permalink: 'https://imslp.org/wiki/Prelude',
      metadata: { id: 500 } // Missing basic_info
    };

    const enrichedDoc = {
      ...docWithoutBasicInfo,
      metadata: { id: 500, basic_info: { page_id: 500, page_title: 'Prelude' } }
    };

    (model.findOne as jest.Mock).mockReturnValue({ lean: () => ({ exec: () => Promise.resolve(docWithoutBasicInfo) }) });
    jest.spyOn(service as any, 'fetchFromMediaWiki').mockResolvedValue(null);
    jest.spyOn(service as any, 'fetchViaMwClient').mockResolvedValue(enrichedDoc);
    jest.spyOn(service as any, 'fetchAndStoreFromExternal').mockResolvedValue(null);

    const res = await service.ensureByPermalink('https://imslp.org/wiki/Prelude');
    expect(res.workId).toBe('500');
    expect(service['fetchViaMwClient']).toHaveBeenCalled();
  });

  it('ensureByPermalink enriches when files missing', async () => {
    const docWithoutFiles = {
      workId: '600',
      title: 'Fugue',
      composer: 'Bach',
      permalink: 'https://imslp.org/wiki/Fugue',
      metadata: { basic_info: { page_id: 600, page_title: 'Fugue' }, files: [] }
    };

    const enrichedDoc = {
      ...docWithoutFiles,
      metadata: { basic_info: { page_id: 600, page_title: 'Fugue' }, files: [{ name: 'score.pdf' }] }
    };

    (model.findOne as jest.Mock).mockReturnValue({ lean: () => ({ exec: () => Promise.resolve(docWithoutFiles) }) });
    jest.spyOn(service as any, 'fetchFromMediaWiki').mockResolvedValue(null);
    jest.spyOn(service as any, 'fetchViaMwClient').mockResolvedValue(enrichedDoc);
    jest.spyOn(service as any, 'fetchAndStoreFromExternal').mockResolvedValue(null);

    const res = await service.ensureByPermalink('https://imslp.org/wiki/Fugue');
    expect(res.workId).toBe('600');
  });

  it('ensureByPermalink handles all fetch methods returning null', async () => {
    (model.findOne as jest.Mock).mockReturnValue({ lean: () => ({ exec: () => Promise.resolve(null) }) });
    jest.spyOn(service as any, 'fetchFromMediaWiki').mockResolvedValue(null);
    jest.spyOn(service as any, 'fetchViaMwClient').mockResolvedValue(null);
    jest.spyOn(service as any, 'fetchAndStoreFromExternal').mockResolvedValue(null);

    await expect(service.ensureByPermalink('https://imslp.org/wiki/NonExistent')).rejects.toThrow('Unable to resolve IMSLP permalink');
  });

  it('enrichByWorkId returns null for non-existent work', async () => {
    (model.findOne as jest.Mock).mockReturnValue({ lean: () => ({ exec: () => Promise.resolve(null) }) });
    jest.spyOn(service as any, 'fetchViaMwClient').mockResolvedValue(null);

    const result = await service.enrichByWorkId('999');
    expect(result).toBeNull();
  });

  it('enrichByWorkId fetches and enriches existing work', async () => {
    const existingDoc = { workId: '700', permalink: 'https://imslp.org/wiki/Symphony' };
    const enrichedDoc = { workId: '700', title: 'Symphony', composer: 'Mozart', metadata: { basic_info: { page_id: 700 } } };

    (model.findOne as jest.Mock).mockReturnValue({ lean: () => ({ exec: () => Promise.resolve(existingDoc) }) });
    jest.spyOn(service as any, 'fetchViaMwClient').mockResolvedValue(enrichedDoc);

    const result = await service.enrichByWorkId('700');
    expect(result).toEqual(enrichedDoc);
  });

  it('enrichByWorkId handles numeric workId without existing doc', async () => {
    const enrichedDoc = { workId: '800', title: 'Quartet', metadata: { basic_info: { page_id: 800 } } };

    (model.findOne as jest.Mock).mockReturnValue({ lean: () => ({ exec: () => Promise.resolve(null) }) });
    jest.spyOn(service as any, 'fetchViaMwClient').mockResolvedValue(enrichedDoc);

    const result = await service.enrichByWorkId('800');
    expect(result).toEqual(enrichedDoc);
  });

  it('search handles special characters in query', async () => {
    const docs = [
      { workId: '900', title: 'Test & Query', composer: 'Smith', permalink: 'https://imslp.org/wiki/900', metadata: { basic_info: { page_id: 900, page_title: 'Test & Query' } } }
    ];
    (model.find as jest.Mock).mockReturnValue(chain(docs));
    const result = await service.search('Test & Query', 5);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Test & Query');
  });

  it('ensureByWorkId handles doc without metadata', async () => {
    const doc = { workId: '1000', title: 'No Metadata', composer: 'Unknown', permalink: 'https://imslp.org/wiki/1000' };
    (model.findOne as jest.Mock).mockReturnValue({ lean: () => ({ exec: () => Promise.resolve(doc) }) });
    const res = await service.ensureByWorkId('1000');
    expect(res.workId).toBe('1000');
    expect(res.metadata.title).toBe('No Metadata');
  });

  it('toDto extracts data from various metadata structures', async () => {
    // Test via ensureByWorkId which uses toDto internally
    const doc = {
      workId: '1100',
      title: 'Complex Work',
      composer: 'Beethoven',
      permalink: 'https://imslp.org/wiki/1100',
      metadata: {
        basic_info: { page_id: 1100, page_title: 'Complex Work', composer_names: ['Beethoven', 'Ludwig van'] },
        files: [{ name: 'score.pdf', size: 1024 }]
      }
    };
    (model.findOne as jest.Mock).mockReturnValue({ lean: () => ({ exec: () => Promise.resolve(doc) }) });
    const res = await service.ensureByWorkId('1100');
    expect(res.metadata.workId).toBe('1100');
    expect(res.metadata.title).toBe('Complex Work');
    expect(res.metadata.composer).toBe('Beethoven');
  });
});