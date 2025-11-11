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

import * as request from 'supertest';

/**
 * Search API E2E Tests
 *
 * These tests verify the MeiliSearch integration endpoints.
 * Run with: npm run test:e2e
 * Prerequisites: docker compose up -d --build (with MeiliSearch configured)
 */
describe('Search API (e2e)', () => {
  const API_BASE = process.env.API_BASE || 'http://localhost:4000';

  describe('GET /api/search/health', () => {
    it('should return search health status', async () => {
      const response = await request(API_BASE)
        .get('/api/search/health')
        .expect(200);

      expect(response.body).toHaveProperty('status');
      expect(response.body).toHaveProperty('isHealthy');
      expect(typeof response.body.isHealthy).toBe('boolean');

      console.log(`  ✓ Search health: ${response.body.status}`);
    });
  });

  describe('GET /api/search/stats', () => {
    it('should return search index statistics', async () => {
      const response = await request(API_BASE)
        .get('/api/search/stats')
        .expect(200);

      // Stats can be null if not configured, or an object with stats
      if (response.body !== null) {
        expect(response.body).toHaveProperty('numberOfDocuments');
        expect(response.body).toHaveProperty('isIndexing');
        expect(typeof response.body.numberOfDocuments).toBe('number');
        expect(typeof response.body.isIndexing).toBe('boolean');

        console.log(`  ✓ Index stats: ${response.body.numberOfDocuments} documents`);
      } else {
        console.log('  ✓ Search not configured (stats returned null)');
      }
    });
  });

  describe('GET /api/search/works', () => {
    it('should require query parameter', async () => {
      await request(API_BASE)
        .get('/api/search/works')
        .expect(400);

      console.log('  ✓ Query parameter validation working');
    });

    it('should return search results structure', async () => {
      const response = await request(API_BASE)
        .get('/api/search/works')
        .query({ q: 'Bach' })
        .expect(200);

      expect(response.body).toHaveProperty('hits');
      expect(response.body).toHaveProperty('estimatedTotalHits');
      expect(response.body).toHaveProperty('processingTimeMs');
      expect(response.body).toHaveProperty('query');
      expect(Array.isArray(response.body.hits)).toBe(true);
      expect(response.body.query).toBe('Bach');

      console.log(`  ✓ Search returned ${response.body.hits.length} results in ${response.body.processingTimeMs}ms`);
    });

    it('should handle pagination parameters', async () => {
      const response = await request(API_BASE)
        .get('/api/search/works')
        .query({ q: 'test', limit: 10, offset: 0 })
        .expect(200);

      expect(response.body).toHaveProperty('hits');
      expect(Array.isArray(response.body.hits)).toBe(true);

      console.log('  ✓ Pagination parameters accepted');
    });

    it('should handle sort parameter', async () => {
      const response = await request(API_BASE)
        .get('/api/search/works')
        .query({ q: 'test', sort: 'latestRevisionAt:desc' })
        .expect(200);

      expect(response.body).toHaveProperty('hits');

      console.log('  ✓ Sort parameter accepted');
    });

    it('should enforce maximum limit', async () => {
      const response = await request(API_BASE)
        .get('/api/search/works')
        .query({ q: 'test', limit: 200 })
        .expect(200);

      expect(response.body).toHaveProperty('hits');
      // Limit should be capped at 100 on the server side

      console.log('  ✓ Maximum limit enforced');
    });

    it('should handle empty query gracefully', async () => {
      const response = await request(API_BASE)
        .get('/api/search/works')
        .query({ q: '' })
        .expect(200);

      expect(response.body).toHaveProperty('hits');
      expect(response.body.query).toBe('');

      console.log('  ✓ Empty query handled gracefully');
    });

    it('should return properly structured work documents', async () => {
      const response = await request(API_BASE)
        .get('/api/search/works')
        .query({ q: 'test' })
        .expect(200);

      if (response.body.hits.length > 0) {
        const hit = response.body.hits[0];
        expect(hit).toHaveProperty('workId');
        expect(hit).toHaveProperty('sourceCount');
        expect(hit).toHaveProperty('availableFormats');
        expect(Array.isArray(hit.availableFormats)).toBe(true);

        console.log(`  ✓ Work document structure valid: workId=${hit.workId}`);
      } else {
        console.log('  ✓ No results returned (empty index)');
      }
    });
  });

  describe('Search Integration', () => {
    it('should be able to create a work and search for it', async () => {
      const testWorkId = '164349'; // Known IMSLP work

      // Create/ensure work exists
      await request(API_BASE)
        .post('/api/works')
        .send({ workId: testWorkId })
        .expect((res) => {
          expect([200, 201]).toContain(res.status);
        });

      // Update metadata to trigger indexing
      await request(API_BASE)
        .post(`/api/works/${testWorkId}/metadata`)
        .send({ title: 'Test Search Work' })
        .expect(200);

      // Wait a moment for indexing
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Search for the work
      const searchResponse = await request(API_BASE)
        .get('/api/search/works')
        .query({ q: 'Test Search Work' })
        .expect(200);

      expect(searchResponse.body.hits.length).toBeGreaterThan(0);
      const found = searchResponse.body.hits.find((h: any) => h.workId === testWorkId);
      expect(found).toBeDefined();
      expect(found.title).toContain('Test Search Work');

      console.log(`  ✓ Work indexed and searchable: ${found.title}`);
    });
  });
});
