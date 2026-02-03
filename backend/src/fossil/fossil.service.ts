import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface FossilCommitFile {
  relativePath: string;
  content: Buffer;
}

export interface FossilCommitRequest {
  workId: string;
  sourceId: string;
  revisionId: string;
  sequenceNumber: number;
  message: string;
  files: FossilCommitFile[];
  branchName?: string;
}

export interface FossilCommitResult {
  artifactId?: string;
  repositoryPath: string;
  branchName?: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

@Injectable()
export class FossilService {
  private readonly logger = new Logger(FossilService.name);
  private readonly rootPath: string;
  private readonly fossilUser: string;

  constructor(private readonly configService: ConfigService) {
    this.rootPath = this.configService.get<string>('FOSSIL_PATH', '/data/fossil_data');
    this.fossilUser = this.configService.get<string>('FOSSIL_USER', 'ourtextscores');
  }

  async commitRevision(request: FossilCommitRequest): Promise<FossilCommitResult> {
    const repositoryPath = await this.ensureRepository(request.workId, request.sourceId);
    const checkoutDir = await fs.mkdtemp(join(tmpdir(), 'ots-fossil-'));

    try {
      await this.runFossil(['open', repositoryPath, '--workdir', checkoutDir]);

      // Normalize requested branch name (if any)
      const branch = request.branchName?.trim();
      let branchExists = false;
      if (branch && branch.length > 0) {
        if (branch.toLowerCase() === 'trunk') {
          // For the default trunk branch, never use --branch.
          // Just make sure we're on trunk before committing.
          try {
            await this.runFossil(['update', 'trunk'], { cwd: checkoutDir });
            branchExists = true;
          } catch {
            // If update fails (e.g., no check-ins yet), fall back to committing
            // to the current checkout without forcing a branch.
            branchExists = false;
          }
        } else {
          // For non-trunk branches, check if the target branch already exists.
          const existingBranches = await this.listBranches(request.workId, request.sourceId);
          branchExists = existingBranches.includes(branch);

          if (branchExists) {
            // Branch exists - update to it before committing
            await this.runFossil(['update', branch], { cwd: checkoutDir });
          }
        }
      }

      for (const file of request.files) {
        const targetPath = join(checkoutDir, file.relativePath);
        await fs.mkdir(dirname(targetPath), { recursive: true });
        const content = this.normalizeLineEndingsIfText(file.relativePath, file.content);
        await fs.writeFile(targetPath, content);
      }

      await this.runFossil(['addremove'], { cwd: checkoutDir });

      const commitMessage = `${request.message} (revision ${request.sequenceNumber}, ${request.revisionId})`;
      const commitArgs = ['commit', '--user', this.fossilUser, '-m', commitMessage];

      if (branch && branch.length > 0 && !branchExists && branch.toLowerCase() !== 'trunk') {
        // Non-trunk branch doesn't exist - use --branch to create it
        commitArgs.push('--branch', branch);
      }
      // If the branch exists (including trunk), we already updated to it,
      // so just commit without --branch.

      await this.runFossil(commitArgs, { cwd: checkoutDir });

      const info = await this.runFossil(['info', 'current'], { cwd: checkoutDir });
      const artifactId = this.extractArtifactId(info.stdout);
      const branchName = this.extractBranchName(info.stdout);

      return { artifactId, repositoryPath, branchName };
    } finally {
      await fs.rm(checkoutDir, { recursive: true, force: true });
    }
  }

  private normalizeLineEndingsIfText(path: string, content: Buffer): Buffer {
    const lower = path.toLowerCase();
    const isText =
      lower.endsWith('.xml') ||
      lower.endsWith('.json') ||
      lower.endsWith('.txt');
    if (!isText) {
      return content;
    }
    const normalized = content.toString('utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return Buffer.from(normalized, 'utf-8');
  }

  private async ensureRepository(workId: string, sourceId: string): Promise<string> {
    const repoDir = join(this.rootPath, workId);
    const repoPath = join(repoDir, `${sourceId}.fossil`);

    try {
      await fs.access(repoPath);
      return repoPath;
    } catch {
      await fs.mkdir(repoDir, { recursive: true });
      // Initialize repository with a known admin user to avoid
      // "cannot determine user" errors inside containers.
      await this.runFossil(['init', '-A', this.fossilUser, repoPath]);
      return repoPath;
    }
  }

  private extractArtifactId(output: string): string | undefined {
    const lines = output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    // Fossil can label the current check-in as "uuid:", "hash:", or "checkout:" depending on version.
    const match = lines.find((line) => {
      const lower = line.toLowerCase();
      return (
        lower.startsWith('uuid:') ||
        lower.startsWith('hash:') ||
        lower.startsWith('checkout:')
      );
    });

    if (!match) return undefined;
    const afterColon = match.split(':', 2)[1]?.trim() ?? '';
    const id = afterColon.split(/\s+/)[0]?.trim();
    return id && id.length > 0 ? id : undefined;
  }

  private runFossil(
    args: string[],
    options: { cwd?: string } = {}
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn('fossil', args, {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`fossil ${args.join(' ')} exited with code ${code}: ${stderr.trim()}`));
        }
      });
    });
  }

  private extractBranchName(output: string): string | undefined {
    const line = output
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.toLowerCase().startsWith('tags:'));
    if (!line) return undefined;
    const raw = line.split(':', 2)[1]?.trim() ?? '';
    if (!raw) return undefined;
    // tags may be comma or space separated depending on fossil output
    const parts = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    // Prefer first non-trunk tag if present; otherwise trunk
    const nonTrunk = parts.find((p) => p.toLowerCase() !== 'trunk');
    return nonTrunk ?? (parts[0] || undefined);
  }

  getRepositoryPath(workId: string, sourceId: string): string {
    const repoDir = join(this.rootPath, workId);
    const repoPath = join(repoDir, `${sourceId}.fossil`);
    return repoPath;
  }

  async diff(
    workId: string,
    sourceId: string,
    artifactA: string,
    artifactB: string,
    relativePath: string
  ): Promise<string> {
    const repoPath = this.getRepositoryPath(workId, sourceId);
    // Use fossil diff with -R to specify repository file
    const { stdout } = await this.runFossil(['-R', repoPath, 'diff', '-r', artifactA, '-r', artifactB, '--', relativePath]);
    return stdout;
  }

  async listBranches(workId: string, sourceId: string): Promise<string[]> {
    const repoPath = this.getRepositoryPath(workId, sourceId);
    try {
      const { stdout } = await this.runFossil(['-R', repoPath, 'branch', 'list']);
      const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      const names = new Set<string>();
      for (const line of lines) {
        // formats can be like: "* trunk" or "  feature-x"
        const name = line.replace(/^\*\s*/, '').trim();
        if (name) names.add(name);
      }
      return Array.from(names);
    } catch {
      return [];
    }
  }

  async removeRepository(workId: string, sourceId: string): Promise<void> {
    const repoDir = join(this.rootPath, workId);
    const repoPath = join(repoDir, `${sourceId}.fossil`);
    try {
      await fs.rm(repoPath, { force: true });
    } catch {
      // ignore
    }
  }

  async moveRepository(
    oldWorkId: string,
    oldSourceId: string,
    newWorkId: string,
    newSourceId: string
  ): Promise<void> {
    const oldDir = join(this.rootPath, oldWorkId);
    const oldPath = join(oldDir, `${oldSourceId}.fossil`);
    const newDir = join(this.rootPath, newWorkId);
    const newPath = join(newDir, `${newSourceId}.fossil`);

    await fs.mkdir(newDir, { recursive: true });
    await fs.rename(oldPath, newPath);
  }
}
