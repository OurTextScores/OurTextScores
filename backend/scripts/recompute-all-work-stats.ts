#!/usr/bin/env ts-node
/**
 * Recompute work stats (including hasReferencePdf) for all works
 * Run with: npm run ts-node scripts/recompute-all-work-stats.ts
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { WorksService } from '../src/works/works.service';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const worksService = app.get(WorksService);

  console.log('Fetching all works...');
  const result = await worksService.getWorksPaginated({ limit: 10000, offset: 0 });
  console.log(`Found ${result.total} works`);

  for (const work of result.works) {
    console.log(`Recomputing stats for work ${work.workId}...`);
    await (worksService as any).recomputeWorkStats(work.workId);
  }

  console.log('Done! All work stats recomputed.');
  await app.close();
}

bootstrap().catch(console.error);
