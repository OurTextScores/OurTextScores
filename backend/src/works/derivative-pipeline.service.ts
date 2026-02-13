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
  musescoreCommand?: string;
  musescoreFallbackCommands?: string[];
}

interface ManifestArtifact {
  type: string;
  locator: StorageLocator;
}

type PdfGenerationMode = 'sync' | 'async' | 'off';

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
  // Optional original MuseScore package buffer when the uploaded score was
  // pre-converted to MusicXML client-side.
  originalMsczBuffer?: Buffer;
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
  pdfDeferred?: boolean;
}

@Injectable()
export class DerivativePipelineService {
  private readonly logger = new Logger(DerivativePipelineService.name);
  private toolVersionsPromise?: Promise<ToolVersions>;
  private static readonly DEFAULT_MUSESCORE_EXPORT_TIMEOUT_MS = 300_000;
  private static readonly MIN_MUSESCORE_EXPORT_TIMEOUT_MS = 10_000;

  constructor(
    private readonly storageService: StorageService,
    private readonly progress: ProgressService
  ) { }

  private getMuseScoreCommands(): string[] {
    const preferred = (process.env.MUSESCORE_CLI || 'musescore3').trim();
    const commands = [preferred, 'musescore4', 'musescore3']
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
    return [...new Set(commands)];
  }

  private getMuseScoreEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      QT_QPA_PLATFORM: process.env.QT_QPA_PLATFORM ?? 'offscreen'
    };
  }

  private getMuseScoreExportTimeoutMs(): number | undefined {
    const raw = (process.env.MUSESCORE_EXPORT_TIMEOUT_MS ?? '').trim();
    if (!raw) {
      return DerivativePipelineService.DEFAULT_MUSESCORE_EXPORT_TIMEOUT_MS;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      this.logger.warn(
        `Invalid MUSESCORE_EXPORT_TIMEOUT_MS="${raw}", using default ${DerivativePipelineService.DEFAULT_MUSESCORE_EXPORT_TIMEOUT_MS}ms`
      );
      return DerivativePipelineService.DEFAULT_MUSESCORE_EXPORT_TIMEOUT_MS;
    }

    if (parsed === 0) {
      this.logger.warn('MUSESCORE_EXPORT_TIMEOUT_MS=0, MuseScore exports will run without a Node timeout.');
      return undefined;
    }

    const timeoutMs = Math.floor(parsed);
    if (timeoutMs < DerivativePipelineService.MIN_MUSESCORE_EXPORT_TIMEOUT_MS) {
      this.logger.warn(
        `MUSESCORE_EXPORT_TIMEOUT_MS=${timeoutMs} is too low, using minimum ${DerivativePipelineService.MIN_MUSESCORE_EXPORT_TIMEOUT_MS}ms`
      );
      return DerivativePipelineService.MIN_MUSESCORE_EXPORT_TIMEOUT_MS;
    }

    return timeoutMs;
  }

  private getPdfGenerationMode(): PdfGenerationMode {
    const raw = (process.env.MUSESCORE_PDF_MODE ?? 'async').trim().toLowerCase();
    if (raw === 'sync' || raw === 'async' || raw === 'off') {
      return raw;
    }
    this.logger.warn(`Invalid MUSESCORE_PDF_MODE="${raw}", defaulting to "async".`);
    return 'async';
  }

  private async runMuseScoreExport(
    inputPath: string,
    outputPath: string,
    purpose: string,
    timeoutMs?: number
  ): Promise<{ command: string }> {
    const effectiveTimeoutMs = timeoutMs ?? this.getMuseScoreExportTimeoutMs();
    const commands = this.getMuseScoreCommands();
    const errors: string[] = [];
    for (const command of commands) {
      try {
        await this.runCommand(command, ['--export-to', outputPath, inputPath], {
          env: this.getMuseScoreEnv(),
          timeoutMs: effectiveTimeoutMs
        });
        if (command !== commands[0]) {
          this.logger.warn(
            `MuseScore fallback succeeded for ${purpose} using ${command}`
          );
        }
        return { command };
      } catch (error) {
        errors.push(`${command}: ${this.readableError(error)}`);
      }
    }

    throw new Error(`All MuseScore commands failed for ${purpose}: ${errors.join(' | ')}`);
  }

  async process(input: DerivativePipelineInput): Promise<DerivativePipelineResult> {
    const publish = (message: string, stage?: string) => this.progress.publish(input.progressId, message, stage);
    const extension = extname((input.originalFilename ?? '').toLowerCase());
    const format = input.format.toLowerCase();
    const derivatives: DerivativeArtifacts = {};
    const notes: string[] = [];
    let pending = false;
    let pdfDeferred = false;
    const revisionSegment = `rev-${input.sequenceNumber.toString().padStart(4, '0')}`;
    const derivativesBaseKey = `${input.workId}/${input.sourceId}/${revisionSegment}`;
    const workspace = await fs.mkdtemp(join(tmpdir(), 'ots-deriv-'));
    const pdfMode = this.getPdfGenerationMode();

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

      if (this.isMuseScoreFile(extension, format)) {
        normalizedMxlPath = join(workspace, 'export.mxl');
        const conversion = await this.runMuseScoreExport(
          inputPath,
          normalizedMxlPath,
          'MuseScore source to MXL'
        );
        normalizedMxlBuffer = await fs.readFile(normalizedMxlPath);
        const canonical = await this.extractCanonicalXml(normalizedMxlPath, workspace);
        canonicalPath = canonical.path;
        canonicalBuffer = canonical.buffer;
        notes.push(`MuseScore conversion to MusicXML completed (${conversion.command}).`);
        publish('MuseScore conversion completed', 'deriv.mscz2mxl');

        // Store the original .mscz file as a derivative artifact.
        // We do not currently expose a dedicated .mscx derivative endpoint.
        if (this.isMuseScorePackage(extension, format)) {
          derivatives.mscz = await this.storeDerivative(
            `${derivativesBaseKey}/score.mscz`,
            input.buffer,
            'application/vnd.musescore.mscz'
          );
          notes.push('Original MuseScore file stored.');
          publish('Stored MuseScore file', 'store.mscz');
        }
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
          const conversion = await this.runMuseScoreExport(
            inputPath,
            normalizedMxlPath,
            'MusicXML to compressed MXL'
          );
          normalizedMxlBuffer = await fs.readFile(normalizedMxlPath);
          notes.push(
            `MuseScore conversion to compressed MusicXML completed (${conversion.command}).`
          );
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

      // If the browser pre-converted .mscz to .mxl, keep the original .mscz
      // as a first-class derivative artifact.
      if (!derivatives.mscz && input.originalMsczBuffer) {
        derivatives.mscz = await this.storeDerivative(
          `${derivativesBaseKey}/score.mscz`,
          input.originalMsczBuffer,
          'application/vnd.musescore.mscz'
        );
        notes.push('Original MuseScore file stored from client upload.');
        publish('Stored MuseScore file', 'store.mscz');
      }

      // Generate PDF synchronously only when explicitly requested.
      if (pdfMode === 'sync') {
        try {
          const pdfSourcePath = normalizedMxlPath ?? canonicalPath;
          if (pdfSourcePath) {
            const outPdf = join(workspace, 'score.pdf');
            const conversion = await this.runMuseScoreExport(
              pdfSourcePath,
              outPdf,
              'score PDF export'
            );
            pdfBuffer = await fs.readFile(outPdf);
            notes.push(`PDF generated (${conversion.command}).`);
            publish('PDF generated', 'deriv.pdf');
          }
        } catch (err) {
          notes.push(`Could not generate PDF: ${this.readableError(err)}`);
        }
      } else if (pdfMode === 'async') {
        const hasPdfSource = Boolean(normalizedMxlPath ?? canonicalPath);
        if (hasPdfSource) {
          pdfDeferred = true;
          notes.push('PDF generation deferred to background job.');
          publish('PDF generation queued for background job', 'deriv.pdf.deferred');
        } else {
          notes.push('PDF generation deferred mode enabled, but no exportable score source was produced.');
          publish('PDF generation skipped (no exportable score source)', 'deriv.pdf.skipped');
        }
      } else {
        notes.push('PDF generation disabled by configuration.');
        publish('PDF generation disabled', 'deriv.pdf.skipped');
      }

      if (normalizedMxlBuffer) {
        derivatives.normalizedMxl = await this.storeDerivative(
          `${derivativesBaseKey}/normalized.mxl`,
          normalizedMxlBuffer,
          'application/vnd.recordare.musicxml'
        );
        publish('Stored normalized MXL', 'store.normalized');
      }

      if (canonicalBuffer && canonicalPath) {
        derivatives.canonicalXml = await this.storeDerivative(
          `${derivativesBaseKey}/canonical.xml`,
          canonicalBuffer,
          'application/xml'
        );
        publish('Stored canonical XML', 'store.canonical');
      } else {
        pending = true;
        notes.push('Canonical MusicXML could not be produced.');
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
      if (derivatives.pdf) {
        artifacts.push({ type: 'pdf', locator: derivatives.pdf });
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
        pending,
        pdfDeferred
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
        pending: true,
        pdfDeferred
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

  async generateDeferredPdfArtifacts(input: {
    workId: string;
    sourceId: string;
    sequenceNumber: number;
    normalizedMxl?: StorageLocator;
    canonicalXml?: StorageLocator;
  }): Promise<{ pdf?: StorageLocator; thumbnail?: StorageLocator }> {
    const source = input.normalizedMxl ?? input.canonicalXml;
    if (!source) {
      return {};
    }

    const revisionSegment = `rev-${input.sequenceNumber.toString().padStart(4, '0')}`;
    const derivativesBaseKey = `${input.workId}/${input.sourceId}/${revisionSegment}`;
    const workspace = await fs.mkdtemp(join(tmpdir(), 'ots-deferred-pdf-'));

    try {
      const sourceBuffer = await this.storageService.getObjectBuffer(
        source.bucket,
        source.objectKey
      );
      const sourceExtension =
        source.contentType === 'application/xml' ? '.xml' : '.mxl';
      const sourcePath = join(workspace, `deferred-source${sourceExtension}`);
      await fs.writeFile(sourcePath, sourceBuffer);

      const outPdf = join(workspace, 'score.pdf');
      await this.runMuseScoreExport(
        sourcePath,
        outPdf,
        'deferred score PDF export'
      );
      const pdfBuffer = await fs.readFile(outPdf);

      const pdf = await this.storeDerivative(
        `${derivativesBaseKey}/score.pdf`,
        pdfBuffer,
        'application/pdf'
      );

      const thumbnailBuffer = await this.generateThumbnail(pdfBuffer, workspace);
      let thumbnail: StorageLocator | undefined;
      if (thumbnailBuffer) {
        thumbnail = await this.storeDerivative(
          `${derivativesBaseKey}/thumbnail.png`,
          thumbnailBuffer,
          'image/png'
        );
      }

      return { pdf, thumbnail };
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
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
    if (this.isMuseScoreSource(extension, format)) {
      return 'score.mscx';
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

  private isMuseScoreSource(extension: string, format: string): boolean {
    return extension === '.mscx' || format === 'application/vnd.musescore.mscx';
  }

  private isMuseScoreFile(extension: string, format: string): boolean {
    return this.isMuseScorePackage(extension, format) || this.isMuseScoreSource(extension, format);
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
    const museCommands = this.getMuseScoreCommands();
    const museCmd = museCommands[0] || 'musescore3';
    const [musescore] = await Promise.all([
      this.getCommandVersion(museCmd, ['--version']),
    ]);
    return {
      musescore3: musescore,
      musescoreCommand: museCmd,
      musescoreFallbackCommands: museCommands.slice(1)
    };
  }

  private async getCommandVersion(command: string, args: string[]): Promise<string> {
    try {
      const { stdout } = await this.runCommand(command, args, {
        env: this.getMuseScoreEnv(),
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
