import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import * as AdmZip from 'adm-zip';
import { StorageService } from '../storage/storage.service';
import { ProgressService } from '../progress/progress.service';
import { StorageLocator } from './schemas/storage-locator.schema';
import { DerivativeArtifacts } from './schemas/derivatives.schema';

interface ToolVersions {
  musescore3: string;
  linearizedMusicXml: string;
  musicdiff: string;
}

interface ManifestArtifact {
  type: string;
  locator: StorageLocator;
}

export interface DerivativeManifest {
  version: number;
  generatedAt: string;
  workId: string;
  sourceId: string;
  sequenceNumber: number;
  tooling: ToolVersions;
  notes: string[];
  pending: boolean;
  artifacts: Array<{
    type: string;
    bucket: string;
    objectKey: string;
    sizeBytes: number;
    contentType: string;
    checksum: { algorithm: string; hexDigest: string };
  }>;
}

export interface DerivativePipelineInput {
  workId: string;
  sourceId: string;
  sequenceNumber: number;
  format: string;
  originalFilename?: string;
  buffer: Buffer;
  rawStorage: StorageLocator;
  previousCanonicalXml?: StorageLocator;
  // Optional progress channel identifier for SSE updates
  progressId?: string;
}

export interface DerivativePipelineResult {
  derivatives: DerivativeArtifacts;
  manifest?: StorageLocator;
  manifestData?: DerivativeManifest;
  notes: string[];
  pending: boolean;
}

@Injectable()
export class DerivativePipelineService {
  private readonly logger = new Logger(DerivativePipelineService.name);
  private toolVersionsPromise?: Promise<ToolVersions>;

  constructor(
    private readonly storageService: StorageService,
    private readonly progress: ProgressService
  ) { }

  private getMuseScoreCommand(): string {
    return process.env.MUSESCORE_CLI || 'musescore3';
  }

  async process(input: DerivativePipelineInput): Promise<DerivativePipelineResult> {
    const publish = (message: string, stage?: string) => this.progress.publish(input.progressId, message, stage);
    const extension = extname((input.originalFilename ?? '').toLowerCase());
    const format = input.format.toLowerCase();
    const derivatives: DerivativeArtifacts = {};
    const notes: string[] = [];
    let pending = false;
    const revisionSegment = `rev-${input.sequenceNumber.toString().padStart(4, '0')}`;
    const derivativesBaseKey = `${input.workId}/${input.sourceId}/${revisionSegment}`;
    const workspace = await fs.mkdtemp(join(tmpdir(), 'ots-deriv-'));

    try {
      const inputFileName =
        input.originalFilename && input.originalFilename.trim().length > 0
          ? input.originalFilename
          : this.fallbackName(extension, format);
      const inputPath = join(workspace, inputFileName);
      await fs.writeFile(inputPath, input.buffer);
      publish(`Saved input ${inputFileName}`, 'deriv.input');

      let canonicalPath: string | undefined;
      let canonicalBuffer: Buffer | undefined;
      let normalizedMxlPath: string | undefined;
      let normalizedMxlBuffer: Buffer | undefined;
      let pdfBuffer: Buffer | undefined;

      const museCmd = this.getMuseScoreCommand();

      if (this.isMuseScorePackage(extension, format)) {
        normalizedMxlPath = join(workspace, 'export.mxl');
        await this.runCommand(museCmd, ['--export-to', normalizedMxlPath, inputPath], {
          env: {
            ...process.env,
            QT_QPA_PLATFORM: process.env.QT_QPA_PLATFORM ?? 'offscreen'
          },
          timeoutMs: 60_000
        });
        normalizedMxlBuffer = await fs.readFile(normalizedMxlPath);
        const canonical = await this.extractCanonicalXml(normalizedMxlPath, workspace);
        canonicalPath = canonical.path;
        canonicalBuffer = canonical.buffer;
        notes.push('MuseScore conversion to MusicXML completed.');
        publish('MuseScore conversion completed', 'deriv.mscz2mxl');

        // Store the original .mscz file as a derivative artifact
        derivatives.mscz = await this.storeDerivative(
          `${derivativesBaseKey}/score.mscz`,
          input.buffer,
          'application/vnd.musescore.mscz'
        );
        notes.push('Original MuseScore file stored.');
        publish('Stored MuseScore file', 'store.mscz');
      } else if (this.isCompressedMusicXml(extension, format)) {
        normalizedMxlPath = inputPath;
        normalizedMxlBuffer = input.buffer;
        const canonical = await this.extractCanonicalXml(normalizedMxlPath, workspace);
        canonicalPath = canonical.path;
        canonicalBuffer = canonical.buffer;
        notes.push('Compressed MusicXML detected; canonical XML extracted.');
        publish('Canonical XML extracted from MXL', 'deriv.canonical');
      } else if (this.isPlainMusicXml(extension, format)) {
        canonicalPath = inputPath;
        canonicalBuffer = input.buffer;
        normalizedMxlPath = join(workspace, 'converted.mxl');
        try {
          await this.runCommand(museCmd, ['--export-to', normalizedMxlPath, inputPath], {
            env: {
              ...process.env,
              QT_QPA_PLATFORM: process.env.QT_QPA_PLATFORM ?? 'offscreen'
            },
            timeoutMs: 60_000
          });
          normalizedMxlBuffer = await fs.readFile(normalizedMxlPath);
          notes.push('MuseScore conversion to compressed MusicXML completed.');
          publish('Compressed MXL generated from XML', 'deriv.xml2mxl');
        } catch (err) {
          pending = true;
          notes.push(
            `Could not convert MusicXML to compressed MXL: ${this.readableError(err)}`
          );
        }
      } else {
        pending = true;
        notes.push('Unsupported format for derivative generation.');
      }

      // Attempt PDF generation via MuseScore from the best available source
      try {
        const pdfSourcePath = normalizedMxlPath ?? canonicalPath;
        if (pdfSourcePath) {
          const outPdf = join(workspace, 'score.pdf');
          await this.runCommand(museCmd, ['--export-to', outPdf, pdfSourcePath], {
            env: { ...process.env, QT_QPA_PLATFORM: process.env.QT_QPA_PLATFORM ?? 'offscreen' },
            timeoutMs: 60_000
          });
          pdfBuffer = await fs.readFile(outPdf);
          notes.push('PDF generated.');
          publish('PDF generated', 'deriv.pdf');
        }
      } catch (err) {
        notes.push(`Could not generate PDF: ${this.readableError(err)}`);
      }

      if (normalizedMxlBuffer) {
        derivatives.normalizedMxl = await this.storeDerivative(
          `${derivativesBaseKey}/normalized.mxl`,
          normalizedMxlBuffer,
          'application/vnd.recordare.musicxml'
        );
        publish('Stored normalized MXL', 'store.normalized');
      }

      let linearized:
        | {
          buffer: Buffer;
          path: string;
        }
        | undefined;

      if (canonicalBuffer && canonicalPath) {
        derivatives.canonicalXml = await this.storeDerivative(
          `${derivativesBaseKey}/canonical.xml`,
          canonicalBuffer,
          'application/xml'
        );
        publish('Stored canonical XML', 'store.canonical');

        // Prefer using the MXL container for linearization when available,
        // because the lmx CLI reads only a single line from XML files.
        if (normalizedMxlPath) {
          linearized = await this.generateLinearizedFromMxl(normalizedMxlPath, workspace);
        } else {
          linearized = await this.generateLinearized(canonicalPath, workspace);
        }
        if (linearized) {
          derivatives.linearizedXml = await this.storeDerivative(
            `${derivativesBaseKey}/linearized.lmx`,
            linearized.buffer,
            'text/plain'
          );
          notes.push('Linearized MusicXML generated.');
          publish('Linearized LMX generated', 'deriv.linearized');
          publish('Stored linearized LMX', 'store.linearized');
        } else {
          pending = true;
          notes.push('Linearized MusicXML generation failed.');
        }
      } else {
        pending = true;
        notes.push('Canonical MusicXML could not be produced.');
      }

      // Queue semantic diff asynchronously (post-upload)
      if (canonicalPath && input.previousCanonicalXml) {
        notes.push('musicdiff comparison queued (async).');
        publish('Diff queued (async)', 'diff.queued');
      }

      if (pdfBuffer) {
        derivatives.pdf = await this.storeDerivative(
          `${derivativesBaseKey}/score.pdf`,
          pdfBuffer,
          'application/pdf'
        );
        publish('Stored PDF', 'store.pdf');

        // Generate thumbnail from PDF
        this.logger.log('Starting thumbnail generation...');
        try {
          const thumbnail = await this.generateThumbnail(pdfBuffer, workspace);
          if (thumbnail) {
            this.logger.log(`Thumbnail generated successfully (${thumbnail.length} bytes), storing...`);
            this.logger.log(`Storing to: ${derivativesBaseKey}/thumbnail.png`);
            derivatives.thumbnail = await this.storeDerivative(
              `${derivativesBaseKey}/thumbnail.png`,
              thumbnail,
              'image/png'
            );
            this.logger.log(`Thumbnail stored successfully: ${JSON.stringify(derivatives.thumbnail)}`);
            publish('Stored thumbnail', 'store.thumbnail');
          } else {
            this.logger.warn('Thumbnail generation returned undefined');
          }
        } catch (err) {
          this.logger.error(`Thumbnail generation/storage error: ${this.readableError(err)}`);
          this.logger.error(`Error stack: ${err instanceof Error ? err.stack : String(err)}`);
          notes.push(`Could not generate thumbnail: ${this.readableError(err)}`);
        }
      }

      const tools = await this.getToolVersions();
      const artifacts: ManifestArtifact[] = [
        { type: 'raw', locator: input.rawStorage }
      ];
      if (derivatives.normalizedMxl) {
        artifacts.push({ type: 'normalizedMxl', locator: derivatives.normalizedMxl });
      }
      if (derivatives.canonicalXml) {
        artifacts.push({ type: 'canonicalXml', locator: derivatives.canonicalXml });
      }
      if (derivatives.linearizedXml) {
        artifacts.push({ type: 'linearizedXml', locator: derivatives.linearizedXml });
      }
      if (derivatives.pdf) {
        artifacts.push({ type: 'pdf', locator: derivatives.pdf });
      }
      if (derivatives.musicDiffReport) {
        artifacts.push({ type: 'musicDiffReport', locator: derivatives.musicDiffReport });
      }
      if (derivatives.thumbnail) {
        artifacts.push({ type: 'thumbnail', locator: derivatives.thumbnail });
      }

      const manifestData: DerivativeManifest = {
        version: 1,
        generatedAt: new Date().toISOString(),
        workId: input.workId,
        sourceId: input.sourceId,
        sequenceNumber: input.sequenceNumber,
        tooling: tools,
        notes: [...notes],
        pending,
        artifacts: artifacts.map((artifact) => ({
          type: artifact.type,
          bucket: artifact.locator.bucket,
          objectKey: artifact.locator.objectKey,
          sizeBytes: artifact.locator.sizeBytes,
          contentType: artifact.locator.contentType,
          checksum: artifact.locator.checksum
        }))
      };

      const manifestBuffer = Buffer.from(JSON.stringify(manifestData, null, 2), 'utf-8');
      const manifestLocator = await this.storeDerivative(
        `${derivativesBaseKey}/manifest.json`,
        manifestBuffer,
        'application/json'
      );
      derivatives.manifest = manifestLocator;
      publish('Manifest stored', 'deriv.manifest');

      return {
        derivatives,
        manifest: manifestLocator,
        manifestData,
        notes,
        pending
      };
    } catch (error) {
      const message = this.readableError(error);
      this.logger.error(
        `Derivative pipeline failed for ${input.workId}/${input.sourceId}: ${message}`
      );
      publish('Pipeline failed', 'pipeline.error');
      return {
        derivatives,
        manifest: undefined,
        manifestData: undefined,
        notes: [...notes, `Derivative pipeline error: ${message}`],
        pending: true
      };
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }

  private async storeDerivative(
    objectKey: string,
    buffer: Buffer,
    contentType: string
  ): Promise<StorageLocator> {
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const result = await this.storageService.putDerivativeObject(
      objectKey,
      buffer,
      buffer.length,
      contentType
    );

    return {
      bucket: result.bucket,
      objectKey: result.objectKey,
      sizeBytes: buffer.length,
      checksum: {
        algorithm: 'sha256',
        hexDigest: sha256
      },
      contentType,
      lastModifiedAt: new Date()
    };
  }

  private async storeAuxiliary(
    objectKey: string,
    buffer: Buffer,
    contentType: string
  ): Promise<StorageLocator> {
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const result = await this.storageService.putAuxiliaryObject(
      objectKey,
      buffer,
      buffer.length,
      contentType
    );

    return {
      bucket: result.bucket,
      objectKey: result.objectKey,
      sizeBytes: buffer.length,
      checksum: {
        algorithm: 'sha256',
        hexDigest: sha256
      },
      contentType,
      lastModifiedAt: new Date()
    };
  }

  private fallbackName(extension: string, format: string): string {
    if (this.isPlainMusicXml(extension, format)) {
      return 'score.xml';
    }
    if (this.isCompressedMusicXml(extension, format)) {
      return 'score.mxl';
    }
    if (this.isMuseScorePackage(extension, format)) {
      return 'score.mscz';
    }
    return 'upload.bin';
  }

  private isPlainMusicXml(extension: string, format: string): boolean {
    return (
      extension === '.xml' ||
      extension === '.musicxml' ||
      format === 'application/xml' ||
      format === 'text/xml'
    );
  }

  private isCompressedMusicXml(extension: string, format: string): boolean {
    return (
      extension === '.mxl' ||
      format === 'application/vnd.recordare.musicxml' ||
      format === 'application/vnd.recordare.musicxml+xml'
    );
  }

  private isMuseScorePackage(extension: string, format: string): boolean {
    return extension === '.mscz' || format === 'application/vnd.musescore.mscz';
  }

  private async extractCanonicalXml(
    mxlPath: string,
    workspace: string
  ): Promise<{ path: string; buffer: Buffer }> {
    const zip = new AdmZip(mxlPath);
    const entries = zip.getEntries();

    // 1) Prefer path indicated by META-INF/container.xml if present
    const containerEntry = entries.find((e) =>
      e.entryName.toLowerCase().endsWith('meta-inf/container.xml')
    );
    let targetEntry = undefined as undefined | AdmZip.IZipEntry;
    if (containerEntry) {
      try {
        const xml = containerEntry.getData().toString('utf-8');
        const match = xml.match(/full-path\s*=\s*"([^"]+)"/i);
        const fullPath = match?.[1];
        if (fullPath) {
          targetEntry = entries.find(
            (e) => e.entryName.replace(/\\/g, '/').toLowerCase() === fullPath.toLowerCase()
          );
        }
      } catch {
        // fall through to heuristics
      }
    }

    // 2) Heuristic fallback: choose largest non-META-INF *.musicxml or *.xml file
    if (!targetEntry) {
      const xmlCandidates = entries.filter((e) => {
        const name = e.entryName.replace(/\\/g, '/').toLowerCase();
        if (name.startsWith('meta-inf/')) return false;
        return name.endsWith('.musicxml') || name.endsWith('.xml');
      });
      if (xmlCandidates.length > 0) {
        targetEntry = xmlCandidates
          .map((e) => ({ entry: e, size: e.getData().length }))
          .sort((a, b) => b.size - a.size)[0].entry;
      }
    }

    if (!targetEntry) {
      throw new Error('Compressed MusicXML does not contain an XML document.');
    }

    const buffer = targetEntry.getData();
    const canonicalPath = join(workspace, 'canonical.xml');
    await fs.writeFile(canonicalPath, buffer);
    return { path: canonicalPath, buffer };
  }

  private async generateLinearized(
    canonicalPath: string,
    workspace: string
  ): Promise<{ buffer: Buffer; path: string } | undefined> {
    const linearizedPath = join(workspace, 'linearized.lmx');
    try {
      // Use our wrapper to process full XML content (lmx CLI reads one line).
      const { stdout } = await this.runCommand('python3', [
        'python/linearize.py',
        canonicalPath
      ]);
      const buffer = Buffer.from(stdout, 'utf-8');
      await fs.writeFile(linearizedPath, buffer);
      return { buffer, path: linearizedPath };
    } catch (error) {
      this.logger.warn(
        `Linearized MusicXML generation failed for ${canonicalPath}: ${this.readableError(error)}`
      );
      return undefined;
    }
  }

  private async generateLinearizedFromMxl(
    mxlPath: string,
    workspace: string
  ): Promise<{ buffer: Buffer; path: string } | undefined> {
    const linearizedPath = join(workspace, 'linearized.lmx');
    try {
      // Use our wrapper to properly handle .mxl (supports .musicxml entries).
      const { stdout } = await this.runCommand('python3', [
        'python/linearize.py',
        mxlPath
      ]);
      const buffer = Buffer.from(stdout, 'utf-8');
      await fs.writeFile(linearizedPath, buffer);
      return { buffer, path: linearizedPath };
    } catch (error) {
      this.logger.warn(
        `Linearized MusicXML generation (from MXL) failed for ${mxlPath}: ${this.readableError(error)}`
      );
      return undefined;
    }
  }

  public async generateThumbnail(
    pdfBuffer: Buffer,
    workspace: string
  ): Promise<Buffer | undefined> {
    this.logger.log(`generateThumbnail called with buffer size: ${pdfBuffer.length}`);
    const pdfPath = join(workspace, 'source.pdf');
    const thumbPrefix = join(workspace, 'thumbnail'); // pdftoppm appends extension
    await fs.writeFile(pdfPath, pdfBuffer);
    this.logger.log(`PDF written to: ${pdfPath}`);

    try {
      // Generate PNG thumbnail of the first page
      // -png: Output PNG format
      // -f 1 -l 1: First page only
      // -scale-to 300: Scale to 300px width (maintaining aspect ratio)
      // -singlefile: Write to a single file named prefix.png instead of prefix-1.png
      this.logger.log(`Running pdftoppm command...`);
      await this.runCommand('pdftoppm', [
        '-png',
        '-f',
        '1',
        '-l',
        '1',
        '-scale-to',
        '300',
        '-singlefile',
        pdfPath,
        thumbPrefix
      ]);

      const thumbPath = `${thumbPrefix}.png`;
      this.logger.log(`Reading thumbnail from: ${thumbPath}`);
      const thumbBuffer = await fs.readFile(thumbPath);
      this.logger.log(`Thumbnail read successfully, size: ${thumbBuffer.length}`);
      return thumbBuffer;
    } catch (error) {
      this.logger.warn(`Thumbnail generation failed: ${this.readableError(error)}`);
      return undefined;
    }
  }

  private async getToolVersions(): Promise<ToolVersions> {
    if (!this.toolVersionsPromise) {
      this.toolVersionsPromise = this.fetchToolVersions();
    }
    return this.toolVersionsPromise;
  }

  private async fetchToolVersions(): Promise<ToolVersions> {
    const museCmd = this.getMuseScoreCommand();
    const [musescore, linearized, musicdiff] = await Promise.all([
      this.getCommandVersion(museCmd, ['--version']),
      this.getPythonPackageVersion('linearized-musicxml'),
      this.getPythonPackageVersion('musicdiff')
    ]);
    return {
      musescore3: musescore,
      linearizedMusicXml: linearized,
      musicdiff
    };
  }

  private async getCommandVersion(command: string, args: string[]): Promise<string> {
    try {
      const { stdout } = await this.runCommand(command, args, {
        env: {
          ...process.env,
          QT_QPA_PLATFORM: process.env.QT_QPA_PLATFORM ?? 'offscreen'
        },
        timeoutMs: 10_000
      });
      return stdout.split('\n')[0]?.trim() || 'unknown';
    } catch (error) {
      this.logger.warn(
        `Unable to determine version for ${command}: ${this.readableError(error)}`
      );
      return 'unknown';
    }
  }

  private async getPythonPackageVersion(packageName: string): Promise<string> {
    try {
      const { stdout } = await this.runCommand('python3', ['-m', 'pip', 'show', packageName]);
      const line = stdout
        .split('\n')
        .find((entry) => entry.toLowerCase().startsWith('version:'));
      return line ? line.split(':')[1].trim() : 'unknown';
    } catch (error) {
      this.logger.warn(
        `Unable to determine version for ${packageName}: ${this.readableError(error)}`
      );
      return 'unknown';
    }
  }

  private runCommand(
    command: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      let killed = false;
      let timer: NodeJS.Timeout | undefined;
      if (options.timeoutMs && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          killed = true;
          try { child.kill('SIGTERM'); } catch { }
        }, options.timeoutMs);
      }
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (code === 0 && !killed) {
          resolve({ stdout, stderr });
        } else {
          const reason = killed ? `timed out after ${options.timeoutMs}ms` : `exited with code ${code}`;
          reject(new Error(`${command} ${reason}: ${stderr.trim()}`));
        }
      });
    });
  }

  private readableError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
