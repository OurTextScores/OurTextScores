import { isMergedGrandStaffDeviation } from './scanner-profile-findings';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { ScannerProviderError } from './scanner.errors';
import { assertValidMusicXml } from './scanner-musicxml';
import {
  ScannerCrossStaffFinding,
  ScannerPageProvider,
  ScannerProviderResult,
  ScannerProviderScanInput,
  scannerProviderIdempotencyKey
} from './scanner-provider.contract';
import {
  ScannerProviderConnection,
  ScannerProviderHttpService
} from './scanner-provider-http.service';
import {
  canonicalScoreProfileJson,
  isScannerOtsHomrEngineOptions,
  ScannerOtsHomrEngineOptions
} from './scanner-dual-engine';
import { normaliseReview } from './scanner-provider.service';

/** Strict adapter for the private rareNum OTS-HOMR provider. */
@Injectable()
export class ScannerOtsHomrProviderService implements ScannerPageProvider {
  readonly engine = 'ots-homr' as const;

  constructor(
    private readonly config: ConfigService,
    private readonly http: ScannerProviderHttpService = new ScannerProviderHttpService()
  ) {}

  get expectedRevision(): string {
    return this.text('SCANNER_EXPECTED_OTS_HOMR_CORE_REVISION');
  }

  async regenerateReview(staffs: string[][][]): Promise<Buffer> {
    const result: any = await this.http.postJson({
      connection: { ...this.connection(), timeoutMs: 60_000 },
      path: '/v1/regenerate',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ staffs }),
      nonOkError: {
        message: 'The corrected OTS-HOMR score could not be rebuilt',
        code: 'provider_generation_failed',
        retryable: false
      }
    });
    const musicXml = this.decode(result?.result?.musicXmlBase64, 'MusicXML');
    assertValidMusicXml(musicXml);
    return musicXml;
  }

  async materializeStructured(proposals: Buffer, families: string[]): Promise<Buffer> {
    const allowed = new Set(['beam', 'advance', 'stem', 'tie', 'slur']);
    if (
      families.length !== new Set(families).size ||
      families.some((family) => !allowed.has(family))
    ) {
      throw new ScannerProviderError(
        'OTS-HOMR structured output selection is invalid',
        'provider_invalid_option',
        false
      );
    }
    let stored: any;
    try {
      stored = JSON.parse(proposals.toString('utf8'));
    } catch {
      throw this.invalid('Stored OTS-HOMR structured proposals are invalid');
    }
    if (!this.isStructuredProposalPayload(stored)) {
      throw this.invalid('Stored OTS-HOMR structured proposals are invalid');
    }
    const result: any = await this.http.postJson({
      connection: { ...this.connection(), timeoutMs: 60_000 },
      path: '/v1/materialize-structured',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ...stored, families }),
      nonOkError: {
        message: 'The selected OTS-HOMR head output could not be generated',
        code: 'provider_generation_failed',
        retryable: false
      }
    });
    if (result?.schemaVersion !== 'ots-ots-homr-provider.v2') {
      throw this.invalid('Scanner OTS-HOMR materialization contract verification failed');
    }
    const musicXml = this.decode(result?.result?.musicXmlBase64, 'MusicXML');
    const digest = this.sha(result?.result?.musicXmlSha256);
    if (
      createHash('sha256').update(musicXml).digest('hex') !== digest ||
      JSON.stringify(result?.result?.families) !== JSON.stringify(families)
    ) {
      throw this.invalid('Scanner OTS-HOMR materialized output verification failed');
    }
    assertValidMusicXml(musicXml);
    return musicXml;
  }

  createIdempotencyKey(input: {
    inputSha256: string;
    pageNumber: number;
    detectTitle: boolean;
    generation: number;
    engineOptions?: unknown;
  }): string {
    const options = this.options(input.engineOptions);
    const policy = options.textPolicy ? 'fusion-v1' : options.textDetector;
    const fusionIdentity = options.textPolicy
      ? `;lyrics=${this.text('SCANNER_EXPECTED_OTS_HOMR_LYRICS_REVISION')}:${this.text('SCANNER_EXPECTED_OTS_HOMR_LYRICS_SHA256')}` +
        `;nonLyric=${this.text('SCANNER_EXPECTED_OTS_HOMR_NON_LYRIC_TEXT_REVISION')}:${this.text('SCANNER_EXPECTED_OTS_HOMR_NON_LYRIC_TEXT_SHA256')}` +
        `;calibration=${this.text('SCANNER_EXPECTED_OTS_HOMR_FUSION_CALIBRATION_REVISION')}` +
        ';materializer=review-only-v1'
      : '';
    return scannerProviderIdempotencyKey({
      engine: this.engine,
      modelRevision: this.expectedRevision,
      modelArtifactSha256: this.text('SCANNER_EXPECTED_OTS_HOMR_CORE_SHA256'),
      preprocessingRevision: 'ots-ots-homr-rare-num-v1',
      decodingRevision:
        `detector=${policy}${fusionIdentity};heads=always-v2` +
        `;profile=${this.scoreProfileFingerprint(options)}`,
      engineOptions: options,
      ...input
    });
  }

  /**
   * Optional OCR rows for lyric review: unreviewed text with the semantic gate's verdict. Anything
   * malformed is a contract failure, not something to repair, so a bad row never reaches a person.
   */
  private lyricTextPayload(value: unknown): Record<string, unknown> | undefined {
    if (value === undefined || value === null) return undefined;
    const lyric = value as { status?: unknown; rows?: unknown; rowsOmitted?: unknown };
    const rows = lyric.rows;
    const valid =
      (lyric.status === 'ok' || lyric.status === 'failed') &&
      Array.isArray(rows) &&
      rows.length <= 400 &&
      Number.isInteger(lyric.rowsOmitted) &&
      rows.every((row: Record<string, unknown>) => {
        const box = row?.box as unknown[];
        return (
          Array.isArray(box) &&
          box.length === 4 &&
          box.every((n) => Number.isInteger(n)) &&
          typeof row.text === 'string' &&
          row.text.length <= 500 &&
          typeof row.proposedLyric === 'boolean' &&
          ['Lyrics', 'DirectionText', 'Unknown'].includes(row.semantic as string) &&
          (row.semanticScore === null || typeof row.semanticScore === 'number') &&
          typeof row.ocrConfidence === 'number'
        );
      });
    const direction = (value as { directionRows?: { rows?: unknown; rowsOmitted?: unknown } })
      .directionRows;
    const directionValid =
      direction === undefined ||
      (Array.isArray(direction.rows) &&
        direction.rows.length <= 120 &&
        Number.isInteger(direction.rowsOmitted) &&
        direction.rows.every((row: Record<string, unknown>) => {
          const box = row?.box as unknown[];
          return (
            Array.isArray(box) &&
            box.length === 4 &&
            box.every((n) => Number.isInteger(n)) &&
            typeof row.text === 'string' &&
            row.text.length <= 500 &&
            (row.kind === 'words' || row.kind === 'dynamic') &&
            (row.mark === undefined || typeof row.mark === 'string') &&
            (row.source === undefined || row.source === 'ocr' || row.source === 'classifier') &&
            typeof row.ocrConfidence === 'number'
          );
        }));
    if (!valid || !directionValid)
      throw this.invalid('Scanner OTS-HOMR lyric text contract verification failed');
    return {
      status: lyric.status,
      rows,
      rowsOmitted: lyric.rowsOmitted,
      ...(direction ? { directionRows: direction } : {})
    };
  }

  /** A tally object whose non-negative integer values add up to `total`. */
  private countsSumTo(counts: unknown, total: number): boolean {
    if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return false;
    const values = Object.values(counts as Record<string, unknown>);
    return (
      values.every((n) => Number.isInteger(n) && (n as number) >= 0) &&
      values.reduce((sum: number, n) => sum + (n as number), 0) === total
    );
  }

  async scanPage(input: ScannerProviderScanInput): Promise<ScannerProviderResult> {
    const options = this.options(input.engineOptions);
    if (options.textPolicy && this.text('SCANNER_OTS_HOMR_FUSION_ENABLED') !== '1') {
      throw this.invalid('OTS-HOMR text fusion is not enabled');
    }
    const kind = this.text('SCANNER_OTS_HOMR_PROVIDER_KIND', 'modal');
    if (kind === 'fake') return this.fake(input, options);
    this.assertPins(options);

    const form = new FormData();
    form.set(
      'page',
      new Blob([new Uint8Array(input.image)], { type: input.contentType }),
      input.filename
    );
    form.set('detectTitle', String(input.detectTitle));
    if (options.textPolicy) form.set('textPolicy', JSON.stringify(options.textPolicy));
    else form.set('textDetector', options.textDetector);
    if (options.scoreProfile) {
      form.set('scoreProfile', canonicalScoreProfileJson(options.scoreProfile));
    }
    const envelope: any = await this.http.postJson({
      connection: this.connection(),
      path: '/v1/scan-page',
      headers: { 'Idempotency-Key': input.idempotencyKey, Accept: 'application/json' },
      body: form
    });
    if (
      envelope?.schemaVersion !== 'ots-ots-homr-provider.v2' ||
      envelope?.engine?.name !== this.engine
    ) {
      throw this.invalid('Scanner OTS-HOMR provider contract verification failed');
    }
    const engine = envelope.engine;
    const core = engine.core;
    this.expect(
      engine.serviceRevision,
      'SCANNER_EXPECTED_OTS_HOMR_PROVIDER_REVISION',
      'provider_service_revision_mismatch'
    );
    this.expect(
      core?.repository,
      'SCANNER_EXPECTED_OTS_HOMR_CORE_REPOSITORY',
      'provider_model_artifact_mismatch'
    );
    this.expect(
      core?.revision,
      'SCANNER_EXPECTED_OTS_HOMR_CORE_REVISION',
      'provider_model_revision_mismatch'
    );
    this.expectSha(
      core?.sha256,
      'SCANNER_EXPECTED_OTS_HOMR_CORE_SHA256',
      'provider_model_artifact_mismatch'
    );
    this.expect(
      engine.executionProvider,
      'SCANNER_EXPECTED_OTS_HOMR_EXECUTION_PROVIDER',
      'provider_execution_provider_mismatch'
    );
    if (
      this.sha(envelope?.inputSha256) !== createHash('sha256').update(input.image).digest('hex')
    ) {
      throw new ScannerProviderError(
        'Scanner provider input verification failed',
        'provider_input_digest_mismatch',
        false
      );
    }
    this.verifySelectedComponents(engine, options);
    let fusionArtifact: Buffer | undefined;
    if (options.textPolicy) {
      const summary = envelope?.result?.fusionSummary;
      const regions = envelope?.result?.fusedRegions;
      if (
        !summary ||
        !Array.isArray(regions) ||
        regions.length > 500 ||
        !['accepted', 'review', 'rejected'].every(
          (key) => Number.isInteger(summary[key]) && summary[key] >= 0
        ) ||
        // Rejected candidates are counted, never listed: a real page yields hundreds. Review
        // regions beyond the provider's listing bound are counted in `reviewOmitted`.
        !Number.isInteger(summary.reviewOmitted) ||
        summary.reviewOmitted < 0 ||
        summary.accepted + summary.review - summary.reviewOmitted !== regions.length ||
        regions.some((region: { status?: unknown }) => region?.status === 'rejected') ||
        !this.countsSumTo(summary.rejectedByReason, summary.rejected) ||
        !this.countsSumTo(summary.rejectedByClass, summary.rejected) ||
        !summary.byClass ||
        typeof summary.byClass !== 'object'
      )
        throw this.invalid('Scanner OTS-HOMR text fusion contract verification failed');
      const lyricText = this.lyricTextPayload(envelope?.result?.lyricText);
      fusionArtifact = Buffer.from(
        JSON.stringify({
          textPolicy: engine.textPolicy,
          fusionSummary: summary,
          fusedRegions: regions,
          ...(lyricText ? { lyricText } : {})
        })
      );
      if (fusionArtifact.length > 1_048_576)
        throw this.invalid('Scanner OTS-HOMR text fusion review is too large');
    }
    const candidates = envelope?.result?.candidates;
    const coreCandidate = this.candidate(candidates?.core, 'core');
    const headsCandidate = this.candidate(candidates?.['additional-heads'], 'additional-heads');
    const proposals = this.proposalPayload(headsCandidate.rawReview);
    return {
      engine: this.engine,
      musicXml: coreCandidate.musicXml,
      musicXmlSha256: coreCandidate.musicXmlSha256,
      review: coreCandidate.review,
      nativeArtifacts: {
        'additional-heads-musicxml': headsCandidate.musicXml,
        'structured-heads': proposals,
        ...(fusionArtifact ? { 'text-fusion-review': fusionArtifact } : {})
      },
      outputCandidates: {
        core: { artifactKind: 'musicxml', review: coreCandidate.review },
        'all-structured': {
          artifactKind: 'additional-heads-musicxml',
          review: headsCandidate.review
        }
      },
      availableStructuredHeadFamilies: ['beam', 'advance', 'stem', 'tie', 'slur'],
      crossStaffFindings: this.crossStaffFindings(
        envelope?.result?.crossStaffFindings,
        options.scoreProfile
      ),
      providerRevision: String(engine.serviceRevision),
      modelRevision: String(core.revision),
      requestId: typeof envelope.requestId === 'string' ? envelope.requestId : undefined,
      inferenceMs: Number.isFinite(Number(envelope?.timing?.inferenceMs))
        ? Number(envelope.timing.inferenceMs)
        : undefined,
      provenance: {
        modelArtifact: String(core.repository),
        modelArtifactSha256: String(core.sha256),
        executionProvider: String(engine.executionProvider)
      }
    };
  }

  /**
   * A stable digest of the profile, for the idempotency fingerprint.
   *
   * A profile change has to create a new attempt rather than relabel an existing
   * result: the same page read against a different prior is a different reading, and
   * the findings attached to it describe a profile that is no longer in force.
   * `none` when absent, so adding a profile changes the key and removing it restores
   * the old one.
   */
  private scoreProfileFingerprint(options: ScannerOtsHomrEngineOptions): string {
    if (!options.scoreProfile) return 'none';
    return createHash('sha256')
      .update(canonicalScoreProfileJson(options.scoreProfile))
      .digest('hex');
  }

  /**
   * Findings from the response, kept only where they are well formed.
   *
   * Supplementary evidence: a malformed one is dropped rather than failing the page,
   * which is the opposite of how the model artifacts are treated and deliberately so -
   * losing an annotation costs a reviewer a prompt, losing provenance costs trust.
   */
  private crossStaffFindings(
    value: unknown,
    profile?: { parts?: { expectedStaffCount?: number }[] }
  ): ScannerCrossStaffFinding[] | undefined {
    if (!Array.isArray(value) || value.length === 0) return undefined;
    const findings = value.flatMap((entry) => {
      const finding = entry as Record<string, unknown>;
      if (isMergedGrandStaffDeviation(finding, profile)) return [];
      if (typeof finding?.kind !== 'string' || typeof finding?.message !== 'string') {
        return [];
      }
      const staffIndices = Array.isArray(finding.staffIndices)
        ? finding.staffIndices.filter((index): index is number => Number.isInteger(index))
        : undefined;
      return [
        {
          kind: finding.kind,
          message: finding.message,
          ...(Number.isInteger(finding.system) ? { system: finding.system as number } : {}),
          ...(staffIndices?.length ? { staffIndices } : {}),
          ...(typeof finding.part === 'string' && finding.part ? { part: finding.part } : {})
        }
      ];
    });
    return findings.length > 0 ? findings : undefined;
  }

  private options(value: unknown): ScannerOtsHomrEngineOptions {
    if (!isScannerOtsHomrEngineOptions(value)) {
      throw new ScannerProviderError(
        'OTS-HOMR policy is invalid',
        'provider_invalid_option',
        false
      );
    }
    return value;
  }

  private verifySelectedComponents(engine: any, options: ScannerOtsHomrEngineOptions): void {
    if (options.textPolicy) {
      const policy = engine?.textPolicy;
      if (
        policy?.mode !== 'fusion-v1' ||
        policy?.fusionRevision !== 'fusion-v1' ||
        engine?.textDetector !== undefined ||
        !Array.isArray(policy.detectors) ||
        policy.detectors.length !== 3
      )
        throw this.invalid('Scanner OTS-HOMR text fusion identity is invalid');
      this.expect(
        policy.calibrationRevision,
        'SCANNER_EXPECTED_OTS_HOMR_FUSION_CALIBRATION_REVISION',
        'provider_model_revision_mismatch'
      );
      for (const [id, suffix] of [
        ['lyrics', 'LYRICS'],
        ['non-lyric-text', 'NON_LYRIC_TEXT'],
        ['dynamics', 'DYNAMICS']
      ] as const) {
        const detector = policy.detectors.find((entry: any) => entry?.id === id);
        if (!detector) throw this.invalid('Scanner OTS-HOMR text fusion detector is absent');
        this.expect(
          detector.revision,
          `SCANNER_EXPECTED_OTS_HOMR_${suffix}_REVISION`,
          'provider_model_revision_mismatch'
        );
        this.expectSha(
          detector.sha256,
          `SCANNER_EXPECTED_OTS_HOMR_${suffix}_SHA256`,
          'provider_model_artifact_mismatch'
        );
      }
    } else if (options.textDetector !== 'none') {
      const detector = engine?.textDetector;
      if (detector?.id !== options.textDetector)
        throw this.invalid('Scanner OTS-HOMR detector verification failed');
      this.expect(
        detector.revision,
        `SCANNER_EXPECTED_OTS_HOMR_${options.textDetector === 'lyrics' ? 'LYRICS' : 'NON_LYRIC_TEXT'}_REVISION`,
        'provider_model_revision_mismatch'
      );
      this.expectSha(
        detector.sha256,
        `SCANNER_EXPECTED_OTS_HOMR_${options.textDetector === 'lyrics' ? 'LYRICS' : 'NON_LYRIC_TEXT'}_SHA256`,
        'provider_model_artifact_mismatch'
      );
    }
    const heads = engine?.structuredHeads;
    if (
      heads?.mode !== 'both' ||
      !Array.isArray(heads?.emittedHeadFamilies) ||
      heads.emittedHeadFamilies.includes('dynamic.mark')
    ) {
      throw this.invalid('Scanner OTS-HOMR structured-head verification failed');
    }
    this.expect(
      heads.revision,
      'SCANNER_EXPECTED_OTS_HOMR_HEADS_REVISION',
      'provider_model_revision_mismatch'
    );
    this.expectSha(
      heads.sha256,
      'SCANNER_EXPECTED_OTS_HOMR_HEADS_SHA256',
      'provider_model_artifact_mismatch'
    );
    this.expectSha(
      heads.manifestSha256,
      'SCANNER_EXPECTED_OTS_HOMR_HEADS_MANIFEST_SHA256',
      'provider_model_artifact_mismatch'
    );
    if (heads.compatibleCoreRevision !== engine.core.revision)
      throw this.invalid('Scanner OTS-HOMR head/core compatibility failed');
  }

  private connection(): ScannerProviderConnection {
    return {
      url: this.text('SCANNER_OTS_HOMR_PROVIDER_URL'),
      kind: this.text('SCANNER_OTS_HOMR_PROVIDER_KIND', 'modal'),
      providerToken: this.text('SCANNER_OTS_HOMR_PROVIDER_TOKEN') || undefined,
      modalTokenId: this.text('SCANNER_OTS_HOMR_MODAL_TOKEN_ID') || undefined,
      modalTokenSecret: this.text('SCANNER_OTS_HOMR_MODAL_TOKEN_SECRET') || undefined,
      timeoutMs: Number(this.text('SCANNER_OTS_HOMR_PROVIDER_TIMEOUT_MS', '600000')),
      maxResponseBytes: Number(
        this.text('SCANNER_OTS_HOMR_MAX_PROVIDER_RESPONSE_BYTES', '33554432')
      )
    };
  }

  private assertPins(options: ScannerOtsHomrEngineOptions): void {
    const keys = [
      'SCANNER_EXPECTED_OTS_HOMR_PROVIDER_REVISION',
      'SCANNER_EXPECTED_OTS_HOMR_CORE_REPOSITORY',
      'SCANNER_EXPECTED_OTS_HOMR_CORE_REVISION',
      'SCANNER_EXPECTED_OTS_HOMR_CORE_SHA256',
      'SCANNER_EXPECTED_OTS_HOMR_EXECUTION_PROVIDER'
    ];
    if (options.textPolicy) {
      keys.push(
        'SCANNER_EXPECTED_OTS_HOMR_LYRICS_REVISION',
        'SCANNER_EXPECTED_OTS_HOMR_LYRICS_SHA256',
        'SCANNER_EXPECTED_OTS_HOMR_NON_LYRIC_TEXT_REVISION',
        'SCANNER_EXPECTED_OTS_HOMR_NON_LYRIC_TEXT_SHA256',
        'SCANNER_EXPECTED_OTS_HOMR_FUSION_CALIBRATION_REVISION'
      );
    } else if (options.textDetector !== 'none')
      keys.push(
        `SCANNER_EXPECTED_OTS_HOMR_${options.textDetector === 'lyrics' ? 'LYRICS' : 'NON_LYRIC_TEXT'}_REVISION`,
        `SCANNER_EXPECTED_OTS_HOMR_${options.textDetector === 'lyrics' ? 'LYRICS' : 'NON_LYRIC_TEXT'}_SHA256`
      );
    keys.push(
      'SCANNER_EXPECTED_OTS_HOMR_HEADS_REVISION',
      'SCANNER_EXPECTED_OTS_HOMR_HEADS_SHA256',
      'SCANNER_EXPECTED_OTS_HOMR_HEADS_MANIFEST_SHA256'
    );
    if (keys.some((key) => !this.text(key)))
      throw new ScannerProviderError(
        'OTS-HOMR provenance pins are not configured',
        'provider_not_configured',
        false
      );
  }

  private expect(value: unknown, key: string, code: string): void {
    const expected = this.text(key);
    if (expected && String(value) !== expected) {
      throw new ScannerProviderError(
        'Scanner OTS-HOMR provenance verification failed',
        code,
        false
      );
    }
  }

  private expectSha(value: unknown, key: string, code: string): void {
    const actual = this.sha(value);
    const expected = this.text(key).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(actual) || !/^[a-f0-9]{64}$/.test(expected) || actual !== expected) {
      throw new ScannerProviderError(
        'Scanner OTS-HOMR provenance verification failed',
        code,
        false
      );
    }
  }

  private sha(value: unknown): string {
    return typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value) ? value.toLowerCase() : '';
  }

  private decode(value: unknown, label: string): Buffer {
    const decoded = Buffer.from(typeof value === 'string' ? value : '', 'base64');
    if (!decoded.length) throw this.invalid(`Scanner OTS-HOMR returned invalid ${label}`);
    return decoded;
  }

  private candidate(value: any, label: string) {
    const musicXml = this.decode(value?.musicXmlBase64, `${label} MusicXML`);
    const musicXmlSha256 = this.sha(value?.musicXmlSha256);
    if (createHash('sha256').update(musicXml).digest('hex') !== musicXmlSha256) {
      throw this.invalid(`Scanner OTS-HOMR ${label} MusicXML digest verification failed`);
    }
    assertValidMusicXml(musicXml);
    return {
      musicXml,
      musicXmlSha256,
      review: normaliseReview(value?.review),
      rawReview: value?.review
    };
  }

  private proposalPayload(review: any): Buffer {
    const regeneration = Array.isArray(review?.regeneration) ? review.regeneration : [];
    const hasRegeneration = regeneration.length > 0;
    const payload = {
      schemaVersion: 'ots-structured-proposals.v1',
      title: typeof review?.title === 'string' ? review.title : '',
      staves: hasRegeneration
        ? regeneration.map((voice: any) => voice?.tokens)
        : Array.isArray(review?.staves)
          ? review.staves.map((staff: any) => staff?.tokens)
          : [],
      structured: hasRegeneration
        ? regeneration.map((voice: any) => voice?.structured)
        : Array.isArray(review?.staves)
          ? review.staves.map((staff: any) => staff?.structured)
          : []
    };
    if (!this.isStructuredProposalPayload(payload)) {
      throw this.invalid('Scanner OTS-HOMR structured proposal verification failed');
    }
    return Buffer.from(JSON.stringify(payload));
  }

  private isStructuredProposalPayload(value: any): boolean {
    if (
      value?.schemaVersion !== 'ots-structured-proposals.v1' ||
      typeof value.title !== 'string' ||
      !Array.isArray(value.staves) ||
      !Array.isArray(value.structured) ||
      value.staves.length !== value.structured.length ||
      value.staves.length > 256
    )
      return false;
    return value.staves.every(
      (staff: unknown, index: number) =>
        Array.isArray(staff) &&
        staff.length <= 20_000 &&
        Array.isArray(value.structured[index]) &&
        value.structured[index].length === staff.length &&
        staff.every(
          (token: unknown) =>
            Array.isArray(token) &&
            token.length === 6 &&
            token.every((part) => typeof part === 'string' && part.length <= 256)
        ) &&
        value.structured[index].every(
          (entry: unknown) => entry === null || (typeof entry === 'object' && !!entry)
        )
    );
  }

  private invalid(message: string): ScannerProviderError {
    return new ScannerProviderError(message, 'provider_invalid_response', false);
  }

  private text(key: string, fallback = ''): string {
    return this.config.get<string>(key, fallback).trim();
  }

  private fake(
    input: ScannerProviderScanInput,
    _options: ScannerOtsHomrEngineOptions
  ): ScannerProviderResult {
    const xml = Buffer.from(`<?xml version="1.0"?>
      <score-partwise version="4.0">
        <part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list>
        <part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes></measure></part>
      </score-partwise>`);
    return {
      engine: this.engine,
      musicXml: xml,
      musicXmlSha256: createHash('sha256').update(xml).digest('hex'),
      providerRevision: 'local-fake',
      modelRevision: 'local-fake',
      requestId: input.idempotencyKey.slice(0, 12),
      inferenceMs: 1,
      provenance: {
        modelArtifact: 'local-fake-ots-homr',
        modelArtifactSha256: 'a'.repeat(64),
        executionProvider: 'CPUExecutionProvider'
      }
    };
  }
}
