import { StorageService } from './storage.service';
import { Client } from 'minio';
import { Readable } from 'node:stream';

// Mock the minio module
jest.mock('minio');

describe('StorageService', () => {
  let service: StorageService;
  let mockClient: jest.Mocked<Client>;

  const config = {
    endPoint: 'localhost',
    port: 9000,
    useSSL: false,
    accessKey: 'test-access-key',
    secretKey: 'test-secret-key',
    rawBucket: 'test-raw',
    derivativesBucket: 'test-derivatives',
    auxBucket: 'test-aux'
  };

  beforeEach(() => {
    // Create mock client with all methods we'll use
    mockClient = {
      bucketExists: jest.fn(),
      makeBucket: jest.fn(),
      putObject: jest.fn(),
      getObject: jest.fn(),
      statObject: jest.fn(),
      removeObject: jest.fn()
    } as any;

    // Mock the Client constructor to return our mock
    (Client as jest.MockedClass<typeof Client>).mockImplementation(() => mockClient);

    service = new StorageService(config);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('creates MinIO client with provided config', () => {
      expect(Client).toHaveBeenCalledWith({
        endPoint: 'localhost',
        port: 9000,
        useSSL: false,
        accessKey: 'test-access-key',
        secretKey: 'test-secret-key'
      });
    });

    it('uses default bucket names when not provided', () => {
      const minimalConfig = {
        endPoint: 'localhost',
        port: 9000,
        useSSL: false,
        accessKey: 'key',
        secretKey: 'secret'
      };

      new StorageService(minimalConfig);
      // Service should use default bucket names internally
      expect(Client).toHaveBeenCalled();
    });
  });

  describe('ensureBucket', () => {
    it('creates bucket if it does not exist', async () => {
      mockClient.bucketExists.mockResolvedValue(false);
      mockClient.makeBucket.mockResolvedValue(undefined);

      await service.ensureBucket('new-bucket');

      expect(mockClient.bucketExists).toHaveBeenCalledWith('new-bucket');
      expect(mockClient.makeBucket).toHaveBeenCalledWith('new-bucket', '');
    });

    it('does not create bucket if it already exists', async () => {
      mockClient.bucketExists.mockResolvedValue(true);

      await service.ensureBucket('existing-bucket');

      expect(mockClient.bucketExists).toHaveBeenCalledWith('existing-bucket');
      expect(mockClient.makeBucket).not.toHaveBeenCalled();
    });
  });

  describe('putRawObject', () => {
    it('uploads object to raw bucket', async () => {
      mockClient.bucketExists.mockResolvedValue(true);
      mockClient.putObject.mockResolvedValue({
        etag: 'test-etag-123',
        versionId: 'v1'
      } as any);

      const buffer = Buffer.from('test content');
      const result = await service.putRawObject(
        'test/file.txt',
        buffer,
        buffer.length,
        'text/plain'
      );

      expect(mockClient.putObject).toHaveBeenCalledWith(
        'test-raw',
        'test/file.txt',
        buffer,
        buffer.length,
        { 'Content-Type': 'text/plain' }
      );

      expect(result).toEqual({
        bucket: 'test-raw',
        objectKey: 'test/file.txt',
        etag: 'test-etag-123',
        versionId: 'v1'
      });
    });

    it('ensures bucket exists before uploading', async () => {
      mockClient.bucketExists.mockResolvedValue(false);
      mockClient.makeBucket.mockResolvedValue(undefined);
      mockClient.putObject.mockResolvedValue({ etag: 'etag' } as any);

      const buffer = Buffer.from('data');
      await service.putRawObject('key', buffer, buffer.length, 'application/octet-stream');

      expect(mockClient.bucketExists).toHaveBeenCalledWith('test-raw');
      expect(mockClient.makeBucket).toHaveBeenCalledWith('test-raw', '');
    });

    it('handles Readable stream as body', async () => {
      mockClient.bucketExists.mockResolvedValue(true);
      mockClient.putObject.mockResolvedValue({ etag: 'etag' } as any);

      const stream = Readable.from(['test data']);
      await service.putRawObject('stream-key', stream, 9, 'text/plain');

      expect(mockClient.putObject).toHaveBeenCalledWith(
        'test-raw',
        'stream-key',
        stream,
        9,
        { 'Content-Type': 'text/plain' }
      );
    });
  });

  describe('putDerivativeObject', () => {
    it('uploads object to derivatives bucket', async () => {
      mockClient.bucketExists.mockResolvedValue(true);
      mockClient.putObject.mockResolvedValue({
        etag: 'derivative-etag',
        versionId: 'v2'
      } as any);

      const buffer = Buffer.from('derivative content');
      const result = await service.putDerivativeObject(
        'derivatives/file.pdf',
        buffer,
        buffer.length,
        'application/pdf'
      );

      expect(mockClient.putObject).toHaveBeenCalledWith(
        'test-derivatives',
        'derivatives/file.pdf',
        buffer,
        buffer.length,
        { 'Content-Type': 'application/pdf' }
      );

      expect(result).toEqual({
        bucket: 'test-derivatives',
        objectKey: 'derivatives/file.pdf',
        etag: 'derivative-etag',
        versionId: 'v2'
      });
    });

    it('ensures derivatives bucket exists', async () => {
      mockClient.bucketExists.mockResolvedValue(false);
      mockClient.makeBucket.mockResolvedValue(undefined);
      mockClient.putObject.mockResolvedValue({ etag: 'etag' } as any);

      const buffer = Buffer.from('data');
      await service.putDerivativeObject('key', buffer, buffer.length, 'text/plain');

      expect(mockClient.bucketExists).toHaveBeenCalledWith('test-derivatives');
      expect(mockClient.makeBucket).toHaveBeenCalledWith('test-derivatives', '');
    });
  });

  describe('putAuxiliaryObject', () => {
    it('uploads object to auxiliary bucket', async () => {
      mockClient.bucketExists.mockResolvedValue(true);
      mockClient.putObject.mockResolvedValue({
        etag: 'aux-etag',
        versionId: 'v3'
      } as any);

      const buffer = Buffer.from('auxiliary content');
      const result = await service.putAuxiliaryObject(
        'aux/metadata.json',
        buffer,
        buffer.length,
        'application/json'
      );

      expect(mockClient.putObject).toHaveBeenCalledWith(
        'test-aux',
        'aux/metadata.json',
        buffer,
        buffer.length,
        { 'Content-Type': 'application/json' }
      );

      expect(result).toEqual({
        bucket: 'test-aux',
        objectKey: 'aux/metadata.json',
        etag: 'aux-etag',
        versionId: 'v3'
      });
    });

    it('ensures auxiliary bucket exists', async () => {
      mockClient.bucketExists.mockResolvedValue(false);
      mockClient.makeBucket.mockResolvedValue(undefined);
      mockClient.putObject.mockResolvedValue({ etag: 'etag' } as any);

      const buffer = Buffer.from('data');
      await service.putAuxiliaryObject('key', buffer, buffer.length, 'text/plain');

      expect(mockClient.bucketExists).toHaveBeenCalledWith('test-aux');
      expect(mockClient.makeBucket).toHaveBeenCalledWith('test-aux', '');
    });
  });

  describe('getObjectBuffer', () => {
    it('retrieves object as buffer', async () => {
      const mockStream = new Readable();
      mockStream.push('test data content');
      mockStream.push(null);

      mockClient.getObject.mockResolvedValue(mockStream as any);

      const result = await service.getObjectBuffer('test-bucket', 'test-key');

      expect(mockClient.getObject).toHaveBeenCalledWith('test-bucket', 'test-key');
      expect(result.toString()).toBe('test data content');
    });

    it('handles stream with multiple chunks', async () => {
      const mockStream = new Readable();
      mockStream.push('chunk 1 ');
      mockStream.push('chunk 2 ');
      mockStream.push('chunk 3');
      mockStream.push(null);

      mockClient.getObject.mockResolvedValue(mockStream as any);

      const result = await service.getObjectBuffer('bucket', 'key');

      expect(result.toString()).toBe('chunk 1 chunk 2 chunk 3');
    });

    it('handles stream errors', async () => {
      const mockStream = new Readable({
        read() {
          // Emit error immediately when read is called
          setImmediate(() => {
            this.emit('error', new Error('Stream error'));
          });
        }
      });

      mockClient.getObject.mockResolvedValue(mockStream as any);

      await expect(service.getObjectBuffer('bucket', 'key')).rejects.toThrow('Stream error');
    });
  });

  describe('getAuxObjectBuffer', () => {
    it('retrieves object from auxiliary bucket', async () => {
      mockClient.bucketExists.mockResolvedValue(true);

      const mockStream = new Readable();
      mockStream.push('aux data');
      mockStream.push(null);

      mockClient.getObject.mockResolvedValue(mockStream as any);

      const result = await service.getAuxObjectBuffer('aux-key');

      expect(mockClient.bucketExists).toHaveBeenCalledWith('test-aux');
      expect(mockClient.getObject).toHaveBeenCalledWith('test-aux', 'aux-key');
      expect(result.toString()).toBe('aux data');
    });

    it('ensures auxiliary bucket exists before retrieval', async () => {
      mockClient.bucketExists.mockResolvedValue(false);
      mockClient.makeBucket.mockResolvedValue(undefined);

      const mockStream = new Readable();
      mockStream.push('data');
      mockStream.push(null);

      mockClient.getObject.mockResolvedValue(mockStream as any);

      await service.getAuxObjectBuffer('key');

      expect(mockClient.bucketExists).toHaveBeenCalledWith('test-aux');
      expect(mockClient.makeBucket).toHaveBeenCalledWith('test-aux', '');
    });
  });

  describe('statAuxObject', () => {
    it('returns true if object exists', async () => {
      mockClient.bucketExists.mockResolvedValue(true);
      mockClient.statObject.mockResolvedValue({} as any);

      const result = await service.statAuxObject('existing-key');

      expect(mockClient.bucketExists).toHaveBeenCalledWith('test-aux');
      expect(mockClient.statObject).toHaveBeenCalledWith('test-aux', 'existing-key');
      expect(result).toBe(true);
    });

    it('returns false if object does not exist', async () => {
      mockClient.bucketExists.mockResolvedValue(true);
      mockClient.statObject.mockRejectedValue(new Error('Not found'));

      const result = await service.statAuxObject('missing-key');

      expect(mockClient.statObject).toHaveBeenCalledWith('test-aux', 'missing-key');
      expect(result).toBe(false);
    });

    it('ensures auxiliary bucket exists before checking', async () => {
      mockClient.bucketExists.mockResolvedValue(false);
      mockClient.makeBucket.mockResolvedValue(undefined);
      mockClient.statObject.mockResolvedValue({} as any);

      await service.statAuxObject('key');

      expect(mockClient.bucketExists).toHaveBeenCalledWith('test-aux');
      expect(mockClient.makeBucket).toHaveBeenCalledWith('test-aux', '');
    });
  });

  describe('deleteObject', () => {
    it('deletes object from specified bucket', async () => {
      mockClient.removeObject.mockResolvedValue(undefined);

      await service.deleteObject('test-bucket', 'test-key');

      expect(mockClient.removeObject).toHaveBeenCalledWith('test-bucket', 'test-key');
    });

    it('handles errors gracefully (ignores missing objects)', async () => {
      mockClient.removeObject.mockRejectedValue(new Error('Object not found'));

      // Should not throw
      await expect(service.deleteObject('bucket', 'missing-key')).resolves.toBeUndefined();

      expect(mockClient.removeObject).toHaveBeenCalledWith('bucket', 'missing-key');
    });

    it('handles various error types', async () => {
      mockClient.removeObject.mockRejectedValue(new Error('Permission denied'));

      // Should not throw regardless of error type
      await expect(service.deleteObject('bucket', 'key')).resolves.toBeUndefined();
    });
  });
});
