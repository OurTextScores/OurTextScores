import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ScannerJob, ScannerJobDocument } from './schemas/scanner-job.schema';

export interface ScannerAlert {
  key: string;
  message: string;
}

/**
 * Design section 13.4 alerts. Deliberately small: one outbound webhook, three
 * conditions, and no new infrastructure. Discord and Slack both accept the
 * payload shape below, so `SCANNER_ALERT_WEBHOOK_URL` can point at either.
 *
 * Alerts carry aggregates and error codes only — never a filename, a job's
 * contents, or a provider credential — for the same reason the telemetry field
 * set is an allow-list.
 */
@Injectable()
export class ScannerAlertService {
  private readonly logger = new Logger('ScannerAlerts');
  /** Edge-triggered: a firing condition stays quiet until it clears. */
  private readonly firing = new Map<string, number>();

  constructor(
    @InjectModel(ScannerJob.name)
    private readonly jobs: Model<ScannerJobDocument>,
    private readonly config: ConfigService
  ) {}

  get enabled(): boolean {
    return Boolean(this.webhookUrl);
  }

  private get webhookUrl(): string {
    return this.config.get<string>('SCANNER_ALERT_WEBHOOK_URL', '').trim();
  }

  /** Evaluate the conditions and deliver anything newly firing or newly clear. */
  async check(providerDisabledReason?: string): Promise<ScannerAlert[]> {
    const active = await this.evaluate(providerDisabledReason);
    const activeKeys = new Set(active.map((alert) => alert.key));
    const cooldownMs = this.number('SCANNER_ALERT_COOLDOWN_MS', 60 * 60 * 1000);
    const now = Date.now();
    const delivered: ScannerAlert[] = [];

    for (const alert of active) {
      const firedAt = this.firing.get(alert.key);
      // Re-notify only after the cooldown, so a long outage does not spam.
      if (firedAt !== undefined && now - firedAt < cooldownMs) continue;
      this.firing.set(alert.key, now);
      delivered.push(alert);
      await this.deliver(`⚠️ Scanner: ${alert.message}`);
    }

    for (const key of [...this.firing.keys()]) {
      if (activeKeys.has(key)) continue;
      this.firing.delete(key);
      await this.deliver(`✅ Scanner: ${key} has cleared`);
    }
    return delivered;
  }

  async evaluate(providerDisabledReason?: string): Promise<ScannerAlert[]> {
    const alerts: ScannerAlert[] = [];

    if (providerDisabledReason) {
      alerts.push({
        key: 'provider_disabled',
        message: `the provider is disabled and no pages are being scanned (${providerDisabledReason})`
      });
    }

    // Oldest queued job. Section 13.4 wants ten minutes.
    const queueAgeMs = this.number('SCANNER_ALERT_QUEUE_AGE_MS', 10 * 60 * 1000);
    const oldest = await this.jobs
      .find({ status: 'queued', queuedAt: { $lte: new Date(Date.now() - queueAgeMs) } })
      .sort({ queuedAt: 1 })
      .limit(1)
      .lean()
      .exec();
    const queuedAt = (oldest[0] as any)?.queuedAt;
    if (queuedAt) {
      const minutes = Math.round((Date.now() - new Date(queuedAt).getTime()) / 60_000);
      alerts.push({
        key: 'queue_stalled',
        message: `a job has been queued for ${minutes} minutes without being picked up`
      });
    }

    // Page failure rate over a window, with a minimum sample so one bad page in
    // three does not page anyone.
    const windowMs = this.number('SCANNER_ALERT_WINDOW_MS', 15 * 60 * 1000);
    const minSample = this.number('SCANNER_ALERT_MIN_SAMPLE', 10);
    const threshold = Number(this.config.get<string>('SCANNER_ALERT_FAILURE_RATE', '0.1'));
    const recent = await this.jobs
      .find({ updatedAt: { $gte: new Date(Date.now() - windowMs) } })
      .select({ pages: 1 })
      .lean()
      .exec();

    let succeeded = 0;
    let failed = 0;
    const byCode: Record<string, number> = {};
    for (const job of recent as any[]) {
      for (const page of job.pages || []) {
        if (page.status === 'succeeded') succeeded += 1;
        else if (page.status === 'failed') {
          failed += 1;
          const code = String(page.errorCode || 'unknown');
          byCode[code] = (byCode[code] || 0) + 1;
        }
      }
    }
    const total = succeeded + failed;
    if (total >= minSample && failed / total > threshold) {
      const worst = Object.entries(byCode).sort((left, right) => right[1] - left[1])[0];
      alerts.push({
        key: 'page_failure_rate',
        message:
          `${failed} of ${total} pages failed in the last ` +
          `${Math.round(windowMs / 60_000)} minutes` +
          (worst ? ` (mostly ${worst[0]})` : '')
      });
    }
    return alerts;
  }

  private async deliver(message: string): Promise<void> {
    // Always log, so the condition is recorded even with no webhook configured.
    this.logger.warn(message);
    const url = this.webhookUrl;
    if (!url) return;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `content` is Discord, `text` is Slack; sending both works with either.
        body: JSON.stringify({ content: message, text: message }),
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) {
        this.logger.error(`Scanner alert webhook returned HTTP ${response.status}`);
      }
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      // An alerting failure must never disturb scanning.
      this.logger.error(
        `Scanner alert webhook failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private number(key: string, fallback: number): number {
    const parsed = Number(this.config.get<string>(key, String(fallback)));
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  }
}
