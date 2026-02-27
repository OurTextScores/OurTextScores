/*
 * Copyright (C) 2025 OurTextScores Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AnalyticsService } from './analytics/analytics.service';

function parseDateOrUndefined(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ISO date: "${value}"`);
  }
  return parsed;
}

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  try {
    const from = parseDateOrUndefined(process.env.ROLLUP_FROM);
    const to = parseDateOrUndefined(process.env.ROLLUP_TO);
    const timezone = (process.env.ROLLUP_TIMEZONE || '').trim() || undefined;
    const analytics = app.get(AnalyticsService);

    const result = await analytics.backfillDailyRollups({ from, to, timezone });
    console.log(
      `[analytics.rollups] timezone=${result.timezone} updated=${result.updated} totalDays=${result.totalDays}`
    );
  } finally {
    await app.close();
  }
}

bootstrap().catch((error) => {
  console.error('[analytics.rollups] backfill failed:', error?.message || error);
  process.exit(1);
});
