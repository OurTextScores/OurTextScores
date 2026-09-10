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
import { SearchService } from './search/search.service';
import { Model } from 'mongoose';
import { Work } from './works/schemas/work.schema';

async function bootstrap() {
  console.log('🔄 Starting MeiliSearch re-indexing...\n');

  // Create application context
  const app = await NestFactory.createApplicationContext(AppModule);

  try {
    const searchService = app.get(SearchService);
    const workModel = app.get<Model<Work>>('WorkModel');

    // Check if MeiliSearch is configured
    const health = await searchService.getHealth();
    if (!health.isHealthy) {
      console.error('❌ MeiliSearch is not healthy or not configured');
      console.error('   Status:', health.status);
      console.error('\nPlease ensure MEILI_HOST and MEILI_MASTER_KEY are set in your .env file');
      process.exit(1);
    }

    console.log('✅ MeiliSearch is healthy\n');

    // Fetch all works from MongoDB
    console.log('📊 Fetching all works from database...');
    const works = await workModel.find({}).lean().exec();
    console.log(`   Found ${works.length} works\n`);

    if (works.length === 0) {
      console.log('ℹ️  No works to index');
      await app.close();
      return;
    }

    // Transform works to search documents
    console.log('🔨 Preparing documents for indexing...');
    const searchDocuments = works.map((work) => ({
      id: work.workId,
      workId: work.workId,
      title: work.title,
      composer: work.composer,
      catalogNumber: work.catalogNumber,
      sourceCount: work.sourceCount || 0,
      availableFormats: work.availableFormats || [],
      latestRevisionAt: work.latestRevisionAt
        ? new Date(work.latestRevisionAt).getTime()
        : undefined
    }));

    // Batch index all works
    console.log('📤 Indexing documents in MeiliSearch...');
    const batchSize = 100;
    let indexed = 0;

    for (let i = 0; i < searchDocuments.length; i += batchSize) {
      const batch = searchDocuments.slice(i, i + batchSize);
      await searchService.indexWorks(batch);
      indexed += batch.length;
      console.log(`   Indexed ${indexed}/${searchDocuments.length} works`);
    }

    console.log('\n✅ Re-indexing completed successfully!');

    // Show index stats
    console.log('\n📈 Index Statistics:');
    const stats = await searchService.getStats();
    if (stats) {
      console.log(`   Total documents: ${stats.numberOfDocuments || 0}`);
      console.log(`   Index size: ${stats.isIndexing ? 'Indexing...' : 'Ready'}`);
    }

    console.log('\n🔍 You can now test the search:');
    console.log('   curl https://api.ourtextscores.com/api/search/works?q=<search-term>');
  } catch (error) {
    console.error('\n❌ Error during re-indexing:', error.message);
    console.error('\nStack trace:', error.stack);
    process.exit(1);
  } finally {
    await app.close();
  }
}

bootstrap();
