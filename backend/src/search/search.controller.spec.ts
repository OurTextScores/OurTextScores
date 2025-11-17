import { Test, TestingModule } from '@nestjs/testing';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { UsersService } from '../users/users.service';

describe('SearchController', () => {
  let controller: SearchController;
  let searchService: jest.Mocked<SearchService>;
  let usersService: jest.Mocked<UsersService>;

  beforeEach(async () => {
    searchService = {
      searchWorks: jest.fn(),
      getHealth: jest.fn(),
      getStats: jest.fn()
    } as any;

    usersService = {
      searchUsersByUsername: jest.fn()
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SearchController],
      providers: [
        { provide: SearchService, useValue: searchService },
        { provide: UsersService, useValue: usersService }
      ]
    }).compile();

    controller = module.get<SearchController>(SearchController);
  });

  describe('searchWorks', () => {
    it('should search with default parameters', async () => {
      const mockResults = {
        hits: [
          {
            id: '123',
            workId: '123',
            title: 'Test Work',
            composer: 'Test Composer',
            sourceCount: 1,
            availableFormats: ['application/xml']
          }
        ],
        estimatedTotalHits: 1,
        processingTimeMs: 5,
        query: 'test'
      };

      searchService.searchWorks.mockResolvedValue(mockResults);

      const result = await controller.searchWorks('test');

      expect(searchService.searchWorks).toHaveBeenCalledWith('test', {
        limit: 20,
        offset: 0,
        sort: undefined
      });
      expect(result).toEqual(mockResults);
    });

    it('should parse limit and offset parameters', async () => {
      searchService.searchWorks.mockResolvedValue({
        hits: [],
        estimatedTotalHits: 0,
        processingTimeMs: 0,
        query: 'test'
      });

      await controller.searchWorks('test', '50', '10');

      expect(searchService.searchWorks).toHaveBeenCalledWith('test', {
        limit: 50,
        offset: 10,
        sort: undefined
      });
    });

    it('should enforce maximum limit of 100', async () => {
      searchService.searchWorks.mockResolvedValue({
        hits: [],
        estimatedTotalHits: 0,
        processingTimeMs: 0,
        query: 'test'
      });

      await controller.searchWorks('test', '200');

      expect(searchService.searchWorks).toHaveBeenCalledWith('test', {
        limit: 100,
        offset: 0,
        sort: undefined
      });
    });

    it('should pass sort parameter', async () => {
      searchService.searchWorks.mockResolvedValue({
        hits: [],
        estimatedTotalHits: 0,
        processingTimeMs: 0,
        query: 'test'
      });

      await controller.searchWorks('test', undefined, undefined, 'latestRevisionAt:desc');

      expect(searchService.searchWorks).toHaveBeenCalledWith('test', {
        limit: 20,
        offset: 0,
        sort: ['latestRevisionAt:desc']
      });
    });

    it('should handle empty query', async () => {
      searchService.searchWorks.mockResolvedValue({
        hits: [],
        estimatedTotalHits: 0,
        processingTimeMs: 0,
        query: ''
      });

      await controller.searchWorks('');

      expect(searchService.searchWorks).toHaveBeenCalledWith('', {
        limit: 20,
        offset: 0,
        sort: undefined
      });
    });
  });

  describe('getHealth', () => {
    it('should return health status', async () => {
      const mockHealth = { status: 'healthy', isHealthy: true };
      searchService.getHealth.mockResolvedValue(mockHealth);

      const result = await controller.getHealth();

      expect(result).toEqual(mockHealth);
      expect(searchService.getHealth).toHaveBeenCalled();
    });
  });

  describe('getStats', () => {
    it('should return index statistics', async () => {
      const mockStats = {
        numberOfDocuments: 42,
        isIndexing: false,
        fieldDistribution: {
          title: 42,
          composer: 40
        }
      };
      searchService.getStats.mockResolvedValue(mockStats);

      const result = await controller.getStats();

      expect(result).toEqual(mockStats);
      expect(searchService.getStats).toHaveBeenCalled();
    });
  });

  describe('searchUsers', () => {
    it('returns empty results when query is blank', async () => {
      const result = await controller.searchUsers('', undefined, undefined);
      expect(result).toEqual({ users: [], total: 0, limit: 20, offset: 0 });
      expect(usersService.searchUsersByUsername).not.toHaveBeenCalled();
    });

    it('delegates to UsersService with pagination', async () => {
      usersService.searchUsersByUsername.mockResolvedValue({
        users: [{ id: '1', username: 'alice', displayName: 'Alice' }],
        total: 1
      });

      const result = await controller.searchUsers('ali', '10', '5');

      expect(usersService.searchUsersByUsername).toHaveBeenCalledWith('ali', {
        limit: 10,
        offset: 5
      });
      expect(result).toEqual({
        users: [{ id: '1', username: 'alice', displayName: 'Alice' }],
        total: 1,
        limit: 10,
        offset: 5
      });
    });
  });
});
