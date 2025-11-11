import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SearchService } from './search.service';

describe('SearchService', () => {
  let service: SearchService;
  let configService: jest.Mocked<ConfigService>;

  beforeEach(async () => {
    configService = {
      get: jest.fn()
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SearchService,
        { provide: ConfigService, useValue: configService }
      ]
    }).compile();

    service = module.get<SearchService>(SearchService);
  });

  describe('when MeiliSearch is not configured', () => {
    beforeEach(() => {
      configService.get.mockReturnValue(undefined);
    });

    it('should handle missing configuration gracefully', async () => {
      await service.onModuleInit();
      const health = await service.getHealth();
      expect(health.status).toBe('not_configured');
      expect(health.isHealthy).toBe(false);
    });

    it('should return empty search results', async () => {
      await service.onModuleInit();
      const results = await service.searchWorks('test');
      expect(results.hits).toEqual([]);
      expect(results.estimatedTotalHits).toBe(0);
    });

    it('should skip indexing when not configured', async () => {
      await service.onModuleInit();
      // Should not throw
      await expect(service.indexWork({
        id: '123',
        workId: '123',
        sourceCount: 0,
        availableFormats: []
      })).resolves.not.toThrow();
    });
  });

  describe('indexWork', () => {
    it('should skip indexing when search is not configured', async () => {
      configService.get.mockReturnValue(undefined);
      await service.onModuleInit();

      await service.indexWork({
        id: '123',
        workId: '123',
        title: 'Test Work',
        composer: 'Test Composer',
        sourceCount: 1,
        availableFormats: ['application/xml']
      });

      // Should complete without error
      expect(true).toBe(true);
    });
  });

  describe('indexWorks', () => {
    it('should handle empty array', async () => {
      configService.get.mockReturnValue(undefined);
      await service.onModuleInit();

      await service.indexWorks([]);

      // Should complete without error
      expect(true).toBe(true);
    });
  });

  describe('deleteWork', () => {
    it('should skip deletion when search is not configured', async () => {
      configService.get.mockReturnValue(undefined);
      await service.onModuleInit();

      await service.deleteWork('123');

      // Should complete without error
      expect(true).toBe(true);
    });
  });

  describe('searchWorks', () => {
    it('should return empty results when not configured', async () => {
      configService.get.mockReturnValue(undefined);
      await service.onModuleInit();

      const result = await service.searchWorks('test query', {
        limit: 10,
        offset: 0
      });

      expect(result).toEqual({
        hits: [],
        estimatedTotalHits: 0,
        processingTimeMs: 0,
        query: 'test query'
      });
    });
  });

  describe('getHealth', () => {
    it('should return not_configured when client is not initialized', async () => {
      configService.get.mockReturnValue(undefined);
      await service.onModuleInit();

      const health = await service.getHealth();

      expect(health).toEqual({
        status: 'not_configured',
        isHealthy: false
      });
    });
  });

  describe('getStats', () => {
    it('should return null when index is not initialized', async () => {
      configService.get.mockReturnValue(undefined);
      await service.onModuleInit();

      const stats = await service.getStats();

      expect(stats).toBeNull();
    });
  });

  describe('when MeiliSearch IS configured', () => {
    let mockClient: any;
    let mockIndex: any;

    beforeEach(() => {
      mockIndex = {
        addDocuments: jest.fn().mockResolvedValue({ taskUid: 1 }),
        deleteDocument: jest.fn().mockResolvedValue({ taskUid: 2 }),
        search: jest.fn().mockResolvedValue({
          hits: [],
          estimatedTotalHits: 0,
          processingTimeMs: 10,
          query: 'test'
        }),
        getStats: jest.fn().mockResolvedValue({ numberOfDocuments: 0 }),
        updateSettings: jest.fn().mockResolvedValue({ taskUid: 3 })
      };

      mockClient = {
        health: jest.fn().mockResolvedValue({ status: 'available' }),
        index: jest.fn().mockReturnValue(mockIndex)
      };

      // Mock MeiliSearch constructor
      jest.mock('meilisearch', () => ({
        MeiliSearch: jest.fn().mockImplementation(() => mockClient)
      }));

      configService.get.mockImplementation((key: string) => {
        if (key === 'MEILI_HOST') return 'http://localhost:7700';
        if (key === 'MEILI_MASTER_KEY') return 'test-key';
        return undefined;
      });
    });

    it('should index a work successfully', async () => {
      // Manually set up the service to simulate configured state
      (service as any).worksIndex = mockIndex;

      const work = {
        id: '123',
        workId: '123',
        title: 'Test Work',
        composer: 'Test Composer',
        sourceCount: 1,
        availableFormats: ['xml']
      };

      await service.indexWork(work);

      expect(mockIndex.addDocuments).toHaveBeenCalledWith(
        [{ ...work, id: '123' }],
        { primaryKey: 'id' }
      );
    });

    it('should index multiple works in batch', async () => {
      (service as any).worksIndex = mockIndex;

      const works = [
        { id: '1', workId: '1', sourceCount: 1, availableFormats: [] },
        { id: '2', workId: '2', sourceCount: 2, availableFormats: [] }
      ];

      await service.indexWorks(works);

      expect(mockIndex.addDocuments).toHaveBeenCalledWith(
        works.map(w => ({ ...w, id: w.workId })),
        { primaryKey: 'id' }
      );
    });

    it('should delete a work from index', async () => {
      (service as any).worksIndex = mockIndex;

      await service.deleteWork('123');

      expect(mockIndex.deleteDocument).toHaveBeenCalledWith('123');
    });

    it('should search works successfully', async () => {
      (service as any).worksIndex = mockIndex;

      mockIndex.search.mockResolvedValue({
        hits: [{ workId: '123', title: 'Test' }],
        estimatedTotalHits: 1,
        processingTimeMs: 15,
        query: 'test'
      });

      const result = await service.searchWorks('test', { limit: 10, offset: 0 });

      expect(result.hits).toHaveLength(1);
      expect(result.estimatedTotalHits).toBe(1);
      expect(mockIndex.search).toHaveBeenCalledWith('test', {
        limit: 10,
        offset: 0,
        filter: undefined,
        sort: undefined
      });
    });

    it('should return healthy status when client is available', async () => {
      (service as any).client = mockClient;

      const health = await service.getHealth();

      expect(health.status).toBe('healthy');
      expect(health.isHealthy).toBe(true);
      expect(mockClient.health).toHaveBeenCalled();
    });

    it('should return stats from index', async () => {
      (service as any).worksIndex = mockIndex;

      const stats = await service.getStats();

      expect(stats).toEqual({ numberOfDocuments: 0 });
      expect(mockIndex.getStats).toHaveBeenCalled();
    });

    it('should handle indexing errors gracefully', async () => {
      (service as any).worksIndex = mockIndex;
      mockIndex.addDocuments.mockRejectedValue(new Error('Index error'));

      await service.indexWork({
        id: '123',
        workId: '123',
        sourceCount: 0,
        availableFormats: []
      });

      // Should not throw
      expect(true).toBe(true);
    });

    it('should handle search errors gracefully', async () => {
      (service as any).worksIndex = mockIndex;
      mockIndex.search.mockRejectedValue(new Error('Search error'));

      const result = await service.searchWorks('test');

      expect(result.hits).toEqual([]);
      expect(result.estimatedTotalHits).toBe(0);
    });

    it('should handle health check errors', async () => {
      (service as any).client = mockClient;
      mockClient.health.mockRejectedValue(new Error('Connection failed'));

      const health = await service.getHealth();

      expect(health.isHealthy).toBe(false);
      expect(health.status).toContain('unhealthy');
    });

    it('should handle getStats errors', async () => {
      (service as any).worksIndex = mockIndex;
      mockIndex.getStats.mockRejectedValue(new Error('Stats error'));

      const stats = await service.getStats();

      expect(stats).toBeNull();
    });
  });
});
