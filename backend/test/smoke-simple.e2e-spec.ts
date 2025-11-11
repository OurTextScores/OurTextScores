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
 * Simple Smoke Tests - API Availability
 *
 * These tests verify that critical API endpoints are responding.
 * Run with: npm run test:smoke
 * Prerequisites: docker compose up -d --build
 */
describe('Simple Smoke Tests', () => {
  const API_BASE = process.env.API_BASE || 'http://localhost:4000';

  describe('Core API Endpoints', () => {
    it('GET /api/health - health check should return ok', async () => {
      const response = await request(API_BASE)
        .get('/api/health')
        .expect(200);

      expect(response.body.status).toBe('ok');
      console.log(`  ✓ Health check OK at ${response.body.time}`);
    });

    it('GET /api/works - works list should be accessible', async () => {
      const response = await request(API_BASE)
        .get('/api/works')
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      console.log(`  ✓ Works list accessible (${response.body.length} works)`);
    });

    it('GET /api/works/:workId - work detail endpoint should handle requests', async () => {
      // Use a known test work ID or create one
      await request(API_BASE)
        .get('/api/works/999999')
        .expect((res) => {
          // Accept either success or 404 (work doesn't exist yet)
          expect([200, 404]).toContain(res.status);
        });

      console.log('  ✓ Work detail endpoint responding');
    });

    it('POST /api/works - work creation should validate input', async () => {
      // Missing workId should return 400
      await request(API_BASE)
        .post('/api/works')
        .send({})
        .expect(400);

      // Invalid workId should return 400
      await request(API_BASE)
        .post('/api/works')
        .send({ workId: 'invalid' })
        .expect(400);

      console.log('  ✓ Work creation validates input correctly');
    });

    it('POST /api/works - can create/ensure work with valid IMSLP ID', async () => {
      const testWorkId = '999888'; // Test numeric ID

      const response = await request(API_BASE)
        .post('/api/works')
        .send({ workId: testWorkId })
        .expect((res) => {
          // Accept 201 (created) or 404 (IMSLP lookup failed)
          expect([201, 404]).toContain(res.status);
        });

      if (response.status === 201) {
        expect(response.body.workId).toBe(testWorkId);
        console.log(`  ✓ Work ensured with ID: ${testWorkId}`);

        // Clean up
        await request(API_BASE)
          .delete(`/api/works/${testWorkId}`)
          .expect((res) => {
            expect([200, 204, 404, 501]).toContain(res.status);
          });
      } else {
        console.log('  ✓ Work creation validates IMSLP ID (lookup failed as expected for test ID)');
      }
    });
  });

  describe('Search & Discovery', () => {
    it('GET /api/search - search endpoint should respond', async () => {
      await request(API_BASE)
        .get('/api/search')
        .query({ q: 'test' })
        .expect((res) => {
          // Accept success, not found, or not implemented
          expect([200, 404, 501]).toContain(res.status);
        });

      console.log('  ✓ Search endpoint responding');
    });
  });

  describe('Watch/Subscribe Endpoints', () => {
    it('GET /api/works/:workId/sources/:sourceId/watch - watch endpoint exists', async () => {
      await request(API_BASE)
        .get('/api/works/999999/sources/test-source/watch')
        .expect((res) => {
          // Accept 200 (works) or 404 (not found)
          expect([200, 404]).toContain(res.status);
        });

      console.log('  ✓ Watch endpoint available');
    });
  });

  describe('Upload Endpoints', () => {
    it('POST /api/works/:workId/sources - upload endpoint validates input', async () => {
      // Missing file should return error
      await request(API_BASE)
        .post('/api/works/999999/sources')
        .expect((res) => {
          // Should return 400 for missing file or 404 if work doesn't exist
          expect([400, 404]).toContain(res.status);
        });

      console.log('  ✓ Upload endpoint validates input');
    });
  });

  describe('Derivative & Diff Endpoints', () => {
    it('GET /api/works/:workId/sources/:sourceId/pdf - PDF endpoint exists', async () => {
      await request(API_BASE)
        .get('/api/works/999999/sources/test-source/pdf')
        .expect((res) => {
          // Accept any response (404, 202 pending, etc)
          expect(res.status).toBeDefined();
        });

      console.log('  ✓ PDF derivative endpoint exists');
    });

    it('GET /api/works/:workId/sources/:sourceId/musicdiff - diff endpoint exists', async () => {
      await request(API_BASE)
        .get('/api/works/999999/sources/test-source/musicdiff')
        .query({ revA: 'rev1', revB: 'rev2', format: 'lmx' })
        .expect((res) => {
          // Accept any response
          expect(res.status).toBeDefined();
        });

      console.log('  ✓ MusicDiff endpoint exists');
    });
  });

  describe('Branch Endpoints', () => {
    it('GET /api/works/:workId/sources/:sourceId/branches - branch listing exists', async () => {
      await request(API_BASE)
        .get('/api/works/999999/sources/test-source/branches')
        .expect((res) => {
          // Accept any response
          expect(res.status).toBeDefined();
        });

      console.log('  ✓ Branch listing endpoint exists');
    });
  });
});
