import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { FossilService, FossilCommitRequest } from './fossil.service';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { EventEmitter } from 'node:events';

// Mock node modules
jest.mock('node:child_process');
jest.mock('node:fs', () => ({
  promises: {
    access: jest.fn(),
    mkdir: jest.fn(),
    mkdtemp: jest.fn(),
    writeFile: jest.fn(),
    rm: jest.fn(),
  }
}));

describe('FossilService', () => {
  let service: FossilService;
  let configService: ConfigService;

  const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;
  const mockFs = fs as jest.Mocked<typeof fs>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FossilService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => {
              if (key === 'FOSSIL_PATH') return '/test/fossil';
              if (key === 'FOSSIL_USER') return 'testuser';
              return defaultValue;
            })
          }
        }
      ]
    }).compile();

    service = module.get<FossilService>(FossilService);
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // Helper to create a mock child process
  const createMockChildProcess = (stdout = '', stderr = '', exitCode = 0) => {
    const childProcess = new EventEmitter() as any;
    childProcess.stdout = new EventEmitter();
    childProcess.stderr = new EventEmitter();

    // Simulate async process execution
    setImmediate(() => {
      if (stdout) childProcess.stdout.emit('data', Buffer.from(stdout));
      if (stderr) childProcess.stderr.emit('data', Buffer.from(stderr));
      childProcess.emit('close', exitCode);
    });

    return childProcess;
  };

  describe('constructor', () => {
    it('reads configuration from ConfigService', () => {
      expect(configService.get).toHaveBeenCalledWith('FOSSIL_PATH', '/data/fossil_data');
      expect(configService.get).toHaveBeenCalledWith('FOSSIL_USER', 'ourtextscores');
    });
  });

  describe('getRepositoryPath', () => {
    it('returns correct repository path', () => {
      const path = service.getRepositoryPath('work123', 'source456');
      expect(path).toBe('/test/fossil/work123/source456.fossil');
    });

    it('handles different workId and sourceId combinations', () => {
      const path = service.getRepositoryPath('abc', 'xyz');
      expect(path).toBe('/test/fossil/abc/xyz.fossil');
    });
  });

  describe('commitRevision', () => {
    const mockRequest: FossilCommitRequest = {
      workId: 'work1',
      sourceId: 'source1',
      revisionId: 'rev123',
      sequenceNumber: 1,
      message: 'Initial commit',
      files: [
        { relativePath: 'score.xml', content: Buffer.from('<score/>') }
      ]
    };

    it('creates new repository if it does not exist', async () => {
      mockFs.access.mockRejectedValue(new Error('ENOENT'));
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.mkdtemp.mockResolvedValue('/tmp/ots-fossil-xyz');
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rm.mockResolvedValue(undefined);

      // Mock all fossil commands
      mockSpawn.mockImplementation((command, args) => {
        if (args && args[0] === 'init') {
          return createMockChildProcess('', '', 0);
        }
        if (args && args[0] === 'open') {
          return createMockChildProcess('', '', 0);
        }
        if (args && args[0] === 'addremove') {
          return createMockChildProcess('', '', 0);
        }
        if (args && args[0] === 'commit') {
          return createMockChildProcess('', '', 0);
        }
        if (args && args[0] === 'info') {
          return createMockChildProcess('uuid: abc123\ntags: trunk\n', '', 0);
        }
        return createMockChildProcess('', '', 0);
      });

      const result = await service.commitRevision(mockRequest);

      expect(mockFs.access).toHaveBeenCalledWith('/test/fossil/work1/source1.fossil');
      expect(mockFs.mkdir).toHaveBeenCalledWith('/test/fossil/work1', { recursive: true });
      expect(mockSpawn).toHaveBeenCalledWith('fossil', ['init', '-A', 'testuser', '/test/fossil/work1/source1.fossil'], expect.any(Object));
      expect(result.repositoryPath).toBe('/test/fossil/work1/source1.fossil');
      expect(result.artifactId).toBe('abc123');
    });

    it('uses existing repository if it exists', async () => {
      mockFs.access.mockResolvedValue(undefined);
      mockFs.mkdtemp.mockResolvedValue('/tmp/ots-fossil-xyz');
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rm.mockResolvedValue(undefined);

      mockSpawn.mockImplementation((command, args) => {
        if (args && args[0] === 'open') {
          return createMockChildProcess('', '', 0);
        }
        if (args && args[0] === 'addremove') {
          return createMockChildProcess('', '', 0);
        }
        if (args && args[0] === 'commit') {
          return createMockChildProcess('', '', 0);
        }
        if (args && args[0] === 'info') {
          return createMockChildProcess('hash: def456\ntags: trunk\n', '', 0);
        }
        return createMockChildProcess('', '', 0);
      });

      const result = await service.commitRevision(mockRequest);

      expect(mockFs.access).toHaveBeenCalledWith('/test/fossil/work1/source1.fossil');
      // mkdir is called for creating parent directories of files, but not for repo directory
      expect(mockFs.mkdir).not.toHaveBeenCalledWith('/test/fossil/work1', expect.any(Object));
      expect(result.artifactId).toBe('def456');
    });

    it('writes files to checkout directory', async () => {
      mockFs.access.mockResolvedValue(undefined);
      mockFs.mkdtemp.mockResolvedValue('/tmp/checkout');
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rm.mockResolvedValue(undefined);

      mockSpawn.mockImplementation(() => createMockChildProcess('uuid: abc\ntags: trunk', '', 0));

      await service.commitRevision(mockRequest);

      // mkdir is called with the parent directory of the file (which is the checkout dir for a file at the root)
      expect(mockFs.mkdir).toHaveBeenCalledWith('/tmp/checkout', { recursive: true });
      expect(mockFs.writeFile).toHaveBeenCalledWith('/tmp/checkout/score.xml', Buffer.from('<score/>'));
    });

    it('commits with branch name when provided', async () => {
      const requestWithBranch = { ...mockRequest, branchName: 'feature-branch' };

      mockFs.access.mockResolvedValue(undefined);
      mockFs.mkdtemp.mockResolvedValue('/tmp/checkout');
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rm.mockResolvedValue(undefined);

      mockSpawn.mockImplementation((command, args) => {
        if (args && args[0] === 'commit') {
          expect(args).toContain('--branch');
          expect(args).toContain('feature-branch');
        }
        return createMockChildProcess('uuid: xyz\ntags: feature-branch', '', 0);
      });

      const result = await service.commitRevision(requestWithBranch);

      expect(result.branchName).toBe('feature-branch');
    });

    it('does not use --branch when committing to trunk', async () => {
      const requestOnTrunk = { ...mockRequest, branchName: 'trunk' };

      mockFs.access.mockResolvedValue(undefined);
      mockFs.mkdtemp.mockResolvedValue('/tmp/checkout');
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rm.mockResolvedValue(undefined);

      mockSpawn.mockImplementation((command, args) => {
        if (args && args[0] === 'update') {
          // Should update trunk before committing
          expect(args).toContain('trunk');
        }
        if (args && args[0] === 'commit') {
          // For trunk we must never use --branch
          expect(args).not.toContain('--branch');
        }
        return createMockChildProcess('uuid: xyz\ntags: trunk', '', 0);
      });

      const result = await service.commitRevision(requestOnTrunk);
      expect(result.branchName).toBe('trunk');
    });

    it('does not add branch flag when branchName is empty', async () => {
      const requestWithEmptyBranch = { ...mockRequest, branchName: '  ' };

      mockFs.access.mockResolvedValue(undefined);
      mockFs.mkdtemp.mockResolvedValue('/tmp/checkout');
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rm.mockResolvedValue(undefined);

      mockSpawn.mockImplementation((command, args) => {
        if (args && args[0] === 'commit') {
          expect(args).not.toContain('--branch');
        }
        return createMockChildProcess('uuid: xyz\ntags: trunk', '', 0);
      });

      await service.commitRevision(requestWithEmptyBranch);
    });

    it('includes revision info in commit message', async () => {
      mockFs.access.mockResolvedValue(undefined);
      mockFs.mkdtemp.mockResolvedValue('/tmp/checkout');
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rm.mockResolvedValue(undefined);

      mockSpawn.mockImplementation((command, args) => {
        if (args && args[0] === 'commit') {
          expect(args).toContain('-m');
          const msgIndex = args.indexOf('-m') + 1;
          expect(args[msgIndex]).toContain('revision 1');
          expect(args[msgIndex]).toContain('rev123');
        }
        return createMockChildProcess('uuid: xyz\ntags: trunk', '', 0);
      });

      await service.commitRevision(mockRequest);
    });

    it('cleans up checkout directory after commit', async () => {
      mockFs.access.mockResolvedValue(undefined);
      mockFs.mkdtemp.mockResolvedValue('/tmp/checkout-dir');
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rm.mockResolvedValue(undefined);

      mockSpawn.mockImplementation(() => createMockChildProcess('uuid: xyz\ntags: trunk', '', 0));

      await service.commitRevision(mockRequest);

      expect(mockFs.rm).toHaveBeenCalledWith('/tmp/checkout-dir', { recursive: true, force: true });
    });

    it('cleans up checkout directory even on error', async () => {
      mockFs.access.mockResolvedValue(undefined);
      mockFs.mkdtemp.mockResolvedValue('/tmp/checkout-error');
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rm.mockResolvedValue(undefined);

      mockSpawn.mockImplementation(() => createMockChildProcess('', 'error', 1));

      await expect(service.commitRevision(mockRequest)).rejects.toThrow();

      expect(mockFs.rm).toHaveBeenCalledWith('/tmp/checkout-error', { recursive: true, force: true });
    });

    it('normalizes line endings for text files', async () => {
      const requestWithTextFile: FossilCommitRequest = {
        ...mockRequest,
        files: [
          { relativePath: 'file.xml', content: Buffer.from('line1\r\nline2\r\nline3') }
        ]
      };

      mockFs.access.mockResolvedValue(undefined);
      mockFs.mkdtemp.mockResolvedValue('/tmp/checkout');
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rm.mockResolvedValue(undefined);

      mockSpawn.mockImplementation(() => createMockChildProcess('uuid: xyz\ntags: trunk', '', 0));

      await service.commitRevision(requestWithTextFile);

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        '/tmp/checkout/file.xml',
        Buffer.from('line1\nline2\nline3')
      );
    });

    it('does not normalize line endings for binary files', async () => {
      const binaryContent = Buffer.from([0x00, 0xFF, 0x0D, 0x0A, 0x00]);
      const requestWithBinaryFile: FossilCommitRequest = {
        ...mockRequest,
        files: [
          { relativePath: 'file.bin', content: binaryContent }
        ]
      };

      mockFs.access.mockResolvedValue(undefined);
      mockFs.mkdtemp.mockResolvedValue('/tmp/checkout');
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rm.mockResolvedValue(undefined);

      mockSpawn.mockImplementation(() => createMockChildProcess('uuid: xyz\ntags: trunk', '', 0));

      await service.commitRevision(requestWithBinaryFile);

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        '/tmp/checkout/file.bin',
        binaryContent
      );
    });

    it('handles multiple files in commit', async () => {
      const requestWithMultipleFiles: FossilCommitRequest = {
        ...mockRequest,
        files: [
          { relativePath: 'score.xml', content: Buffer.from('<score/>') },
          { relativePath: 'metadata.json', content: Buffer.from('{}') },
          { relativePath: 'data.txt', content: Buffer.from('text') }
        ]
      };

      mockFs.access.mockResolvedValue(undefined);
      mockFs.mkdtemp.mockResolvedValue('/tmp/checkout');
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rm.mockResolvedValue(undefined);

      mockSpawn.mockImplementation(() => createMockChildProcess('uuid: xyz\ntags: trunk', '', 0));

      await service.commitRevision(requestWithMultipleFiles);

      expect(mockFs.writeFile).toHaveBeenCalledTimes(3);
      expect(mockFs.writeFile).toHaveBeenCalledWith('/tmp/checkout/score.xml', expect.any(Buffer));
      expect(mockFs.writeFile).toHaveBeenCalledWith('/tmp/checkout/metadata.json', expect.any(Buffer));
      expect(mockFs.writeFile).toHaveBeenCalledWith('/tmp/checkout/data.txt', expect.any(Buffer));
    });

    it('extracts artifact ID from "checkout:" format', async () => {
      mockFs.access.mockResolvedValue(undefined);
      mockFs.mkdtemp.mockResolvedValue('/tmp/checkout');
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rm.mockResolvedValue(undefined);

      mockSpawn.mockImplementation((command, args) => {
        if (args && args[0] === 'info') {
          return createMockChildProcess('checkout: checkin123 2024-01-01\ntags: trunk', '', 0);
        }
        return createMockChildProcess('', '', 0);
      });

      const result = await service.commitRevision(mockRequest);

      expect(result.artifactId).toBe('checkin123');
    });

    it('returns undefined artifact ID when not found', async () => {
      mockFs.access.mockResolvedValue(undefined);
      mockFs.mkdtemp.mockResolvedValue('/tmp/checkout');
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rm.mockResolvedValue(undefined);

      mockSpawn.mockImplementation((command, args) => {
        if (args && args[0] === 'info') {
          return createMockChildProcess('no artifact info here\n', '', 0);
        }
        return createMockChildProcess('', '', 0);
      });

      const result = await service.commitRevision(mockRequest);

      expect(result.artifactId).toBeUndefined();
    });
  });

  describe('diff', () => {
    it('returns diff between two artifacts', async () => {
      const diffOutput = '--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new';

      mockSpawn.mockImplementation(() => createMockChildProcess(diffOutput, '', 0));

      const result = await service.diff('work1', 'source1', 'artifact1', 'artifact2', 'file.txt');

      expect(mockSpawn).toHaveBeenCalledWith('fossil', [
        '-R', '/test/fossil/work1/source1.fossil',
        'diff',
        '-r', 'artifact1',
        '-r', 'artifact2',
        '--',
        'file.txt'
      ], expect.any(Object));

      expect(result).toBe(diffOutput);
    });

    it('handles empty diff', async () => {
      mockSpawn.mockImplementation(() => createMockChildProcess('', '', 0));

      const result = await service.diff('work1', 'source1', 'a', 'b', 'file.txt');

      expect(result).toBe('');
    });
  });

  describe('listBranches', () => {
    it('returns list of branch names', async () => {
      const branchOutput = '* trunk\n  feature-1\n  feature-2\n';

      mockSpawn.mockImplementation(() => createMockChildProcess(branchOutput, '', 0));

      const result = await service.listBranches('work1', 'source1');

      expect(mockSpawn).toHaveBeenCalledWith('fossil', [
        '-R', '/test/fossil/work1/source1.fossil',
        'branch',
        'list'
      ], expect.any(Object));

      expect(result).toEqual(['trunk', 'feature-1', 'feature-2']);
    });

    it('handles branch names with asterisks', async () => {
      const branchOutput = '  branch-a\n* current-branch\n  branch-b\n';

      mockSpawn.mockImplementation(() => createMockChildProcess(branchOutput, '', 0));

      const result = await service.listBranches('work1', 'source1');

      expect(result).toContain('current-branch');
      expect(result).toContain('branch-a');
      expect(result).toContain('branch-b');
    });

    it('returns empty array on error', async () => {
      mockSpawn.mockImplementation(() => createMockChildProcess('', 'error', 1));

      const result = await service.listBranches('work1', 'source1');

      expect(result).toEqual([]);
    });

    it('filters out empty lines', async () => {
      const branchOutput = '\n\ntruck\n\n  feature\n\n';

      mockSpawn.mockImplementation(() => createMockChildProcess(branchOutput, '', 0));

      const result = await service.listBranches('work1', 'source1');

      expect(result).toEqual(['truck', 'feature']);
    });

    it('deduplicates branch names', async () => {
      const branchOutput = 'trunk\ntrunk\nfeature\nfeature\n';

      mockSpawn.mockImplementation(() => createMockChildProcess(branchOutput, '', 0));

      const result = await service.listBranches('work1', 'source1');

      expect(result).toEqual(['trunk', 'feature']);
    });
  });

  describe('removeRepository', () => {
    it('removes repository file', async () => {
      mockFs.rm.mockResolvedValue(undefined);

      await service.removeRepository('work1', 'source1');

      expect(mockFs.rm).toHaveBeenCalledWith('/test/fossil/work1/source1.fossil', { force: true });
    });

    it('ignores errors when removing', async () => {
      mockFs.rm.mockRejectedValue(new Error('File not found'));

      // Should not throw
      await expect(service.removeRepository('work1', 'source1')).resolves.toBeUndefined();

      expect(mockFs.rm).toHaveBeenCalled();
    });
  });

  describe('extractBranchName (via commitRevision)', () => {
    it('extracts non-trunk branch name', async () => {
      mockFs.access.mockResolvedValue(undefined);
      mockFs.mkdtemp.mockResolvedValue('/tmp/checkout');
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rm.mockResolvedValue(undefined);

      mockSpawn.mockImplementation((command, args) => {
        if (args && args[0] === 'info') {
          return createMockChildProcess('uuid: abc\ntags: trunk, my-feature', '', 0);
        }
        return createMockChildProcess('', '', 0);
      });

      const result = await service.commitRevision({
        workId: 'w1',
        sourceId: 's1',
        revisionId: 'r1',
        sequenceNumber: 1,
        message: 'test',
        files: []
      });

      expect(result.branchName).toBe('my-feature');
    });

    it('returns trunk when only trunk tag exists', async () => {
      mockFs.access.mockResolvedValue(undefined);
      mockFs.mkdtemp.mockResolvedValue('/tmp/checkout');
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rm.mockResolvedValue(undefined);

      mockSpawn.mockImplementation((command, args) => {
        if (args && args[0] === 'info') {
          return createMockChildProcess('uuid: abc\ntags: trunk', '', 0);
        }
        return createMockChildProcess('', '', 0);
      });

      const result = await service.commitRevision({
        workId: 'w1',
        sourceId: 's1',
        revisionId: 'r1',
        sequenceNumber: 1,
        message: 'test',
        files: []
      });

      expect(result.branchName).toBe('trunk');
    });

    it('handles comma-separated tags', async () => {
      mockFs.access.mockResolvedValue(undefined);
      mockFs.mkdtemp.mockResolvedValue('/tmp/checkout');
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rm.mockResolvedValue(undefined);

      mockSpawn.mockImplementation((command, args) => {
        if (args && args[0] === 'info') {
          return createMockChildProcess('uuid: abc\ntags: tag1,tag2,feature', '', 0);
        }
        return createMockChildProcess('', '', 0);
      });

      const result = await service.commitRevision({
        workId: 'w1',
        sourceId: 's1',
        revisionId: 'r1',
        sequenceNumber: 1,
        message: 'test',
        files: []
      });

      expect(result.branchName).toBe('tag1');
    });

    it('returns undefined when no tags line found', async () => {
      mockFs.access.mockResolvedValue(undefined);
      mockFs.mkdtemp.mockResolvedValue('/tmp/checkout');
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rm.mockResolvedValue(undefined);

      mockSpawn.mockImplementation((command, args) => {
        if (args && args[0] === 'info') {
          return createMockChildProcess('uuid: abc\nno tags here', '', 0);
        }
        return createMockChildProcess('', '', 0);
      });

      const result = await service.commitRevision({
        workId: 'w1',
        sourceId: 's1',
        revisionId: 'r1',
        sequenceNumber: 1,
        message: 'test',
        files: []
      });

      expect(result.branchName).toBeUndefined();
    });
  });
});
