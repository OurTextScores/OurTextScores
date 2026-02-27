import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

let sdk: NodeSDK | null = null;
let started = false;

function parseBoolean(value: string | undefined): boolean {
  return (value || '').trim().toLowerCase() === 'true';
}

function normalizeCollectorBase(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

export async function startOpenTelemetry(): Promise<void> {
  if (started) {
    return;
  }
  if (!parseBoolean(process.env.OTEL_ENABLED)) {
    return;
  }

  if (parseBoolean(process.env.OTEL_DIAGNOSTICS)) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
  }

  const tracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const collectorBase = normalizeCollectorBase(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '');
  const exporterUrl =
    tracesEndpoint?.trim() ||
    (collectorBase ? `${collectorBase}/v1/traces` : 'http://localhost:4318/v1/traces');

  sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ url: exporterUrl }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': {
          enabled: false
        }
      })
    ]
  });

  await sdk.start();
  started = true;
}

export async function stopOpenTelemetry(): Promise<void> {
  if (!sdk) {
    return;
  }
  await sdk.shutdown();
  sdk = null;
  started = false;
}
