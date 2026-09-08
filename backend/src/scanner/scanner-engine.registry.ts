import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  ScannerEngineCapabilitySnapshot,
  ScannerEngineArtifacts,
  ScannerEngineId,
  ScannerEnginePlan
} from './scanner-dual-engine';
import {
  isScannerEngineId,
  scannerEnginePlan,
  scannerEnginePlanForJob
} from './scanner-dual-engine';
import type { ScannerPageProvider } from './scanner-provider.contract';
import { ScannerProviderService } from './scanner-provider.service';
import { ScannerTranscodaProviderService } from './scanner-transcoda-provider.service';
import { ScannerOtsHomrProviderService } from './scanner-ots-homr-provider.service';
import type { ScannerPageResult, ScannerRasterIdentity } from './schemas/scanner-job.schema';
import type { ScannerDescribedPart } from './scanner-measure-analysis';
import type { ScannerPartMatchResult } from './scanner-part-matching';
import type { ScannerMeasureGeometryManifest } from './scanner-comparison-geometry';
import { buildScannerHomrMeasureGeometry } from './scanner-homr-measure-geometry';

export interface ScannerEngineArtifactDefinition {
  contentType: string;
  extension: string;
  maxBytes: number;
  maxBytesConfigKey?: string;
  /** The provider response must contain this artifact for a successful run. */
  requiredProviderOutput: boolean;
}

export interface ScannerMeasureGeometryProducerInput {
  artifactChecksumSha256: string;
  sourceImage: ScannerRasterIdentity;
  producerRevision: string;
  partMatchResult: ScannerPartMatchResult;
  parts: ScannerDescribedPart[];
  review?: ScannerPageResult['review'];
  artifacts: ScannerEngineArtifacts;
  loadArtifact: (kind: string) => Promise<Buffer | undefined>;
  loadRecognitionRaster: () => Promise<Buffer>;
}

export type ScannerMeasureGeometryProducerResult =
  | { status: 'succeeded'; geometry: ScannerMeasureGeometryManifest }
  | { status: 'refused'; refusalReasons: Array<{ code: string; detail: string }> };

export interface ScannerEngineDefinition {
  id: ScannerEngineId;
  displayName: string;
  adapter: ScannerPageProvider;
  readable: boolean;
  enabledForNewJobs: () => boolean;
  budgetExhaustedConfigKey: string;
  providerKindConfigKey: string;
  timeoutConfigKey: string;
  capabilities: ScannerEngineCapabilitySnapshot;
  artifacts: Record<string, ScannerEngineArtifactDefinition>;
  /** Optional engine-specific join from its MusicXML measures to page coordinates. */
  measureGeometryProducer?: (
    input: ScannerMeasureGeometryProducerInput
  ) => ScannerMeasureGeometryProducerResult | Promise<ScannerMeasureGeometryProducerResult>;
}

/**
 * Deployment allowlist and varying behavior for scanner engines.
 * Persisted jobs snapshot capabilities; this registry decides what can execute or be read now.
 */
@Injectable()
export class ScannerEngineRegistry {
  private readonly definitions = new Map<ScannerEngineId, ScannerEngineDefinition>();

  constructor(
    private readonly config: ConfigService,
    homr: ScannerProviderService,
    transcoda: ScannerTranscodaProviderService,
    otsHomr?: ScannerOtsHomrProviderService
  ) {
    this.register({
      id: 'homr',
      displayName: 'HOMR',
      adapter: homr,
      readable: true,
      enabledForNewJobs: () => true,
      budgetExhaustedConfigKey: 'SCANNER_PROVIDER_BUDGET_EXHAUSTED',
      providerKindConfigKey: 'SCANNER_PROVIDER_KIND',
      timeoutConfigKey: 'SCANNER_PROVIDER_TIMEOUT_MS',
      capabilities: {
        displayName: 'HOMR',
        outputArtifactKinds: ['musicxml', 'pdf'],
        supportsSpotReview: true,
        supportsMeasureGeometry: true,
        unsupportedSemanticClasses: []
      },
      measureGeometryProducer: (input) =>
        buildScannerHomrMeasureGeometry({
          engineId: 'homr',
          artifactChecksumSha256: input.artifactChecksumSha256,
          sourceImage: input.sourceImage,
          producerRevision: input.producerRevision,
          partMatchResult: input.partMatchResult,
          parts: input.parts,
          staves: input.review?.staves || []
        }),
      artifacts: {
        musicxml: {
          contentType: 'application/vnd.recordare.musicxml+xml',
          extension: 'musicxml',
          maxBytes: 10_485_760,
          maxBytesConfigKey: 'SCANNER_MAX_MUSICXML_BYTES',
          requiredProviderOutput: true
        },
        pdf: {
          contentType: 'application/pdf',
          extension: 'pdf',
          maxBytes: 52_428_800,
          requiredProviderOutput: false
        }
      }
    });
    this.register({
      id: 'transcoda',
      displayName: 'Transcoda',
      adapter: transcoda,
      readable: true,
      enabledForNewJobs: () => this.bool('SCANNER_TRANSCODA_ENABLED', false),
      budgetExhaustedConfigKey: 'SCANNER_TRANSCODA_PROVIDER_BUDGET_EXHAUSTED',
      providerKindConfigKey: 'SCANNER_TRANSCODA_PROVIDER_KIND',
      timeoutConfigKey: 'SCANNER_TRANSCODA_PROVIDER_TIMEOUT_MS',
      capabilities: {
        displayName: 'Transcoda',
        outputArtifactKinds: ['musicxml', 'kern', 'pdf'],
        supportsSpotReview: false,
        supportsMeasureGeometry: false,
        unsupportedSemanticClasses: ['lyrics', 'dynamics']
      },
      artifacts: {
        musicxml: {
          contentType: 'application/vnd.recordare.musicxml+xml',
          extension: 'musicxml',
          maxBytes: 10_485_760,
          maxBytesConfigKey: 'SCANNER_MAX_MUSICXML_BYTES',
          requiredProviderOutput: true
        },
        kern: {
          contentType: 'text/plain; charset=utf-8',
          extension: 'krn',
          maxBytes: 10_485_760,
          maxBytesConfigKey: 'SCANNER_MAX_KERN_BYTES',
          requiredProviderOutput: true
        },
        // Not a provider output: we render it from this engine's MusicXML so
        // the page can show what Transcoda made of the scan beside the scan.
        pdf: {
          contentType: 'application/pdf',
          extension: 'pdf',
          maxBytes: 52_428_800,
          requiredProviderOutput: false
        }
      }
    });
    if (otsHomr) {
      this.register({
        id: 'ots-homr',
        displayName: 'OTS-HOMR',
        adapter: otsHomr,
        readable: true,
        enabledForNewJobs: () => this.bool('SCANNER_OTS_HOMR_ENABLED', false),
        budgetExhaustedConfigKey: 'SCANNER_OTS_HOMR_PROVIDER_BUDGET_EXHAUSTED',
        providerKindConfigKey: 'SCANNER_OTS_HOMR_PROVIDER_KIND',
        timeoutConfigKey: 'SCANNER_OTS_HOMR_PROVIDER_TIMEOUT_MS',
        capabilities: {
          displayName: 'OTS-HOMR',
          outputArtifactKinds: [
            'musicxml',
            'additional-heads-musicxml',
            'structured-heads',
            'selected-heads-musicxml',
            'pdf'
          ],
          supportsSpotReview: true,
          supportsMeasureGeometry: false,
          unsupportedSemanticClasses: ['dynamics-from-additional-heads']
        },
        artifacts: {
          musicxml: {
            contentType: 'application/vnd.recordare.musicxml+xml',
            extension: 'musicxml',
            maxBytes: 10_485_760,
            maxBytesConfigKey: 'SCANNER_MAX_MUSICXML_BYTES',
            requiredProviderOutput: true
          },
          'additional-heads-musicxml': {
            contentType: 'application/vnd.recordare.musicxml+xml',
            extension: 'heads.musicxml',
            maxBytes: 10_485_760,
            maxBytesConfigKey: 'SCANNER_MAX_MUSICXML_BYTES',
            requiredProviderOutput: true
          },
          'structured-heads': {
            contentType: 'application/json',
            extension: 'heads.json',
            maxBytes: 10_485_760,
            requiredProviderOutput: true
          },
          'selected-heads-musicxml': {
            contentType: 'application/vnd.recordare.musicxml+xml',
            extension: 'sel.musicxml',
            maxBytes: 10_485_760,
            maxBytesConfigKey: 'SCANNER_MAX_MUSICXML_BYTES',
            requiredProviderOutput: false
          },
          pdf: {
            contentType: 'application/pdf',
            extension: 'pdf',
            maxBytes: 52_428_800,
            requiredProviderOutput: false
          }
        }
      });
    }
  }

  /** Registering is a bootstrap operation; duplicate immutable IDs fail closed. */
  register(definition: ScannerEngineDefinition): void {
    if (
      !isScannerEngineId(definition.id) ||
      definition.adapter.engine !== definition.id ||
      this.definitions.has(definition.id) ||
      definition.capabilities.displayName !== definition.displayName
    ) {
      throw new Error(`Invalid or duplicate scanner engine definition: ${definition.id}`);
    }
    const declaredKinds = [...definition.capabilities.outputArtifactKinds].sort();
    const definedKinds = Object.keys(definition.artifacts).sort();
    const extensions = Object.values(definition.artifacts).map((artifact) => artifact.extension);
    if (
      (Boolean(definition.measureGeometryProducer) &&
        !definition.capabilities.supportsMeasureGeometry) ||
      declaredKinds.length !== new Set(declaredKinds).size ||
      declaredKinds.length !== definedKinds.length ||
      declaredKinds.some((kind, index) => kind !== definedKinds[index]) ||
      extensions.length !== new Set(extensions).size ||
      definition.artifacts.musicxml?.requiredProviderOutput !== true ||
      Object.entries(definition.artifacts).some(
        ([kind, artifact]) =>
          !/^[a-z0-9][a-z0-9.-]{0,31}$/.test(kind) ||
          !/^[a-z0-9][a-z0-9.-]{0,15}$/.test(artifact.extension) ||
          !artifact.contentType ||
          /[\r\n]/.test(artifact.contentType) ||
          !Number.isFinite(artifact.maxBytes) ||
          artifact.maxBytes <= 0 ||
          typeof artifact.requiredProviderOutput !== 'boolean'
      )
    ) {
      throw new Error(`Scanner engine artifact contract mismatch: ${definition.id}`);
    }
    const stored = Object.freeze({
      ...definition,
      capabilities: Object.freeze({
        ...definition.capabilities,
        outputArtifactKinds: Object.freeze([...definition.capabilities.outputArtifactKinds]),
        unsupportedSemanticClasses: Object.freeze([
          ...definition.capabilities.unsupportedSemanticClasses
        ])
      }) as unknown as ScannerEngineCapabilitySnapshot,
      artifacts: Object.freeze(
        Object.fromEntries(
          Object.entries(definition.artifacts).map(([kind, artifact]) => [
            kind,
            Object.freeze({ ...artifact })
          ])
        )
      )
    }) as ScannerEngineDefinition;
    this.definitions.set(stored.id, stored);
  }

  get(engineId: ScannerEngineId): ScannerEngineDefinition | undefined {
    return this.definitions.get(engineId);
  }

  readable(engineId: ScannerEngineId): ScannerEngineDefinition | undefined {
    const definition = this.get(engineId);
    return definition?.readable ? definition : undefined;
  }

  enabledDefinitions(): ScannerEngineDefinition[] {
    return [...this.definitions.values()].filter((definition) => definition.enabledForNewJobs());
  }

  /** Safe metadata for the provider selectors; never includes connection details. */
  selectableDefinitions(): Array<
    Pick<ScannerEngineDefinition, 'id' | 'displayName' | 'capabilities'>
  > {
    return this.enabledDefinitions().map(({ id, displayName, capabilities }) => ({
      id,
      displayName,
      capabilities
    }));
  }

  allDefinitions(): ScannerEngineDefinition[] {
    return [...this.definitions.values()];
  }

  newJobPlan(requestedEngineIds: ScannerEngineId[], engineOptions = {}): ScannerEnginePlan {
    const requested = [...new Set(requestedEngineIds)];
    if (
      requestedEngineIds.length < 1 ||
      requestedEngineIds.length > 2 ||
      requested.length !== requestedEngineIds.length
    )
      throw new Error('One or two distinct scanner engines are required');
    for (const engineId of requested) {
      const definition = this.get(engineId);
      if (!definition?.enabledForNewJobs())
        throw new Error('Requested scanner engine is not available for new jobs');
    }
    const definitions = requested.map((engineId) => this.get(engineId)!);
    return scannerEnginePlan(
      definitions.map((definition) => definition.id),
      definitions[0].id,
      Object.fromEntries(definitions.map((definition) => [definition.id, definition.capabilities])),
      engineOptions
    );
  }

  newJobCapacityExhausted(): boolean {
    const definitions = this.enabledDefinitions();
    return (
      definitions.length === 0 ||
      definitions.every((definition) => this.bool(definition.budgetExhaustedConfigKey, false))
    );
  }

  planForJob(job: {
    enginePlan?: ScannerEnginePlan;
    pages?: ScannerPageResult[];
  }): ScannerEnginePlan {
    if (job.enginePlan) return scannerEnginePlanForJob(job);
    const inferred = scannerEnginePlanForJob(
      job,
      this.enabledDefinitions().map((definition) => definition.id)
    );
    return scannerEnginePlan(
      inferred.engineIds,
      inferred.primaryEngineId,
      Object.fromEntries(
        inferred.engineIds.flatMap((engineId) => {
          const definition = this.get(engineId);
          return definition ? [[engineId, definition.capabilities]] : [];
        })
      )
    );
  }

  private bool(key: string, fallback: boolean): boolean {
    const raw = this.config.get<string>(key, String(fallback));
    return raw === 'true' || raw === '1';
  }
}
