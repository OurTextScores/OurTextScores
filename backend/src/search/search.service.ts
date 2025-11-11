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

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MeiliSearch, Index } from 'meilisearch';

export interface WorkSearchDocument {
  id: string; // workId
  workId: string;
  title?: string;
  composer?: string;
  catalogNumber?: string;
  sourceCount: number;
  availableFormats: string[];
  latestRevisionAt?: number; // timestamp for sorting
}

@Injectable()
export class SearchService implements OnModuleInit {
  private readonly logger = new Logger(SearchService.name);
  private client: MeiliSearch | null = null;
  private worksIndex: Index<WorkSearchDocument> | null = null;
  private readonly indexName = 'works';

  constructor(private config: ConfigService) {}

  async onModuleInit() {
    const host = this.config.get<string>('MEILI_HOST');
    const apiKey = this.config.get<string>('MEILI_MASTER_KEY');

    if (!host || !apiKey) {
      this.logger.warn('MeiliSearch not configured (MEILI_HOST or MEILI_MASTER_KEY missing). Search disabled.');
      return;
    }

    try {
      this.client = new MeiliSearch({ host, apiKey });

      // Test connection
      await this.client.health();
      this.logger.log(`Connected to MeiliSearch at ${host}`);

      // Get or create works index
      this.worksIndex = this.client.index<WorkSearchDocument>(this.indexName);

      // Configure index settings
      await this.configureIndex();

      this.logger.log(`Works index "${this.indexName}" configured`);
    } catch (err: any) {
      this.logger.error(`Failed to initialize MeiliSearch: ${err.message}`);
      this.client = null;
      this.worksIndex = null;
    }
  }

  private async configureIndex() {
    if (!this.worksIndex) return;

    try {
      await this.worksIndex.updateSettings({
        searchableAttributes: [
          'title',
          'composer',
          'catalogNumber',
          'workId'
        ],
        filterableAttributes: [
          'sourceCount',
          'availableFormats'
        ],
        sortableAttributes: [
          'latestRevisionAt',
          'sourceCount'
        ],
        displayedAttributes: [
          'workId',
          'title',
          'composer',
          'catalogNumber',
          'sourceCount',
          'availableFormats',
          'latestRevisionAt'
        ],
        rankingRules: [
          'words',
          'typo',
          'proximity',
          'attribute',
          'sort',
          'exactness'
        ]
      });
    } catch (err: any) {
      this.logger.error(`Failed to configure index settings: ${err.message}`);
    }
  }

  /**
   * Index or update a work in the search index
   */
  async indexWork(work: WorkSearchDocument): Promise<void> {
    if (!this.worksIndex) {
      this.logger.debug('Search indexing skipped (not configured)');
      return;
    }

    try {
      // Use workId as the document id
      await this.worksIndex.addDocuments([{ ...work, id: work.workId }], {
        primaryKey: 'id'
      });
      this.logger.debug(`Indexed work ${work.workId}`);
    } catch (err: any) {
      this.logger.error(`Failed to index work ${work.workId}: ${err.message}`);
    }
  }

  /**
   * Index multiple works in batch
   */
  async indexWorks(works: WorkSearchDocument[]): Promise<void> {
    if (!this.worksIndex || works.length === 0) {
      return;
    }

    try {
      const documents = works.map(w => ({ ...w, id: w.workId }));
      await this.worksIndex.addDocuments(documents, { primaryKey: 'id' });
      this.logger.log(`Batch indexed ${works.length} works`);
    } catch (err: any) {
      this.logger.error(`Failed to batch index works: ${err.message}`);
    }
  }

  /**
   * Remove a work from the search index
   */
  async deleteWork(workId: string): Promise<void> {
    if (!this.worksIndex) {
      return;
    }

    try {
      await this.worksIndex.deleteDocument(workId);
      this.logger.debug(`Deleted work ${workId} from index`);
    } catch (err: any) {
      this.logger.error(`Failed to delete work ${workId} from index: ${err.message}`);
    }
  }

  /**
   * Search for works
   */
  async searchWorks(query: string, options?: {
    limit?: number;
    offset?: number;
    filter?: string;
    sort?: string[];
  }): Promise<{
    hits: WorkSearchDocument[];
    estimatedTotalHits: number;
    processingTimeMs: number;
    query: string;
  }> {
    if (!this.worksIndex) {
      // Return empty results if search is not configured
      return {
        hits: [],
        estimatedTotalHits: 0,
        processingTimeMs: 0,
        query
      };
    }

    try {
      const result = await this.worksIndex.search(query, {
        limit: options?.limit ?? 20,
        offset: options?.offset ?? 0,
        filter: options?.filter,
        sort: options?.sort
      });

      return {
        hits: result.hits,
        estimatedTotalHits: result.estimatedTotalHits ?? 0,
        processingTimeMs: result.processingTimeMs,
        query: result.query
      };
    } catch (err: any) {
      this.logger.error(`Search failed: ${err.message}`);
      return {
        hits: [],
        estimatedTotalHits: 0,
        processingTimeMs: 0,
        query
      };
    }
  }

  /**
   * Get search health status
   */
  async getHealth(): Promise<{ status: string; isHealthy: boolean }> {
    if (!this.client) {
      return { status: 'not_configured', isHealthy: false };
    }

    try {
      await this.client.health();
      return { status: 'healthy', isHealthy: true };
    } catch (err: any) {
      return { status: `unhealthy: ${err.message}`, isHealthy: false };
    }
  }

  /**
   * Get index stats
   */
  async getStats(): Promise<any> {
    if (!this.worksIndex) {
      return null;
    }

    try {
      const stats = await this.worksIndex.getStats();
      return stats;
    } catch (err: any) {
      this.logger.error(`Failed to get stats: ${err.message}`);
      return null;
    }
  }
}
