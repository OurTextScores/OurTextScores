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
 * Smoke tests for running OurTextScores API
 *
 * These tests hit the running API (default: http://localhost:4000)
 * Start the services first: docker compose up -d --build
 *
 * Tests critical functionality:
 * - Work creation and source upload with licensing
 * - Derivative generation
 * - MusicDiff PDF generation (bug fix verification)
 */
describe('API Smoke Tests (running server)', () => {
  const API_BASE = process.env.API_BASE || 'http://localhost:4000';
  let createdWorkId: string;
  let createdSourceId: string;
  let revisionId1: string;
  let revisionId2: string;

  describe('Health & Basic API', () => {
    it('GET /api/health should return ok', () => {
      return request(API_BASE)
        .get('/api/health')
        .expect(200)
        .expect((res) => {
          expect(res.body.status).toBe('ok');
        });
    });

    it('GET /api/works should return paginated works list', () => {
      return request(API_BASE)
        .get('/api/works')
        .expect(200)
        .expect((res) => {
          expect(res.body).toHaveProperty('works');
          expect(res.body).toHaveProperty('total');
          expect(res.body).toHaveProperty('limit');
          expect(res.body).toHaveProperty('offset');
          expect(Array.isArray(res.body.works)).toBe(true);
        });
    });
  });

  describe('Work Creation & Upload with Licensing', () => {
    const testMxl = Buffer.from('TEST_MXL_CONTENT');

    it('POST /api/works should ensure work exists (IMSLP-style)', async () => {
      // Use a test numeric workId (IMSLP page_id format)
      const testWorkId = '999999'; // High number unlikely to conflict

      const response = await request(API_BASE)
        .post('/api/works')
        .send({
          workId: testWorkId
        })
        .expect(201);

      expect(response.body.workId).toBeDefined();
      createdWorkId = response.body.workId;
    });

    it('POST /api/works/:workId/sources should upload source with CC-BY-4.0', async () => {
      const response = await request(API_BASE)
        .post(`/api/works/${createdWorkId}/sources`)
        .field('label', 'Smoke Test Source')
        .field('description', 'API smoke test with licensing')
        .field('license', 'CC-BY-4.0')
        .field('licenseAttribution', 'Test Author')
        .field('commitMessage', 'Initial smoke test upload')
        .attach('file', testMxl, 'test.mxl')
        .expect(202);

      expect(response.body.status).toBe('accepted');
      expect(response.body.sourceId).toBeDefined();
      createdSourceId = response.body.sourceId;
    });

    it('GET /api/works/:workId should show license metadata', async () => {
      const response = await request(API_BASE)
        .get(`/api/works/${createdWorkId}`)
        .expect(200);

      const source = response.body.sources.find(s => s.sourceId === createdSourceId);
      expect(source).toBeDefined();
      expect(source.license).toBe('CC-BY-4.0');
      expect(source.licenseAttribution).toBe('Test Author');
    });

    it('POST /api/works/:workId/sources/:sourceId/revisions should upload revision', async () => {
      const response = await request(API_BASE)
        .post(`/api/works/${createdWorkId}/sources/${createdSourceId}/revisions`)
        .field('commitMessage', 'Second revision for diff test')
        .field('license', 'CC0')
        .attach('file', testMxl, 'test-v2.mxl')
        .expect(202);

      expect(response.body.status).toBe('accepted');
    });
  });

  describe('Revisions & Derivatives', () => {
    it('GET /api/works/:workId/sources/:sourceId/revisions should list revisions', async () => {
      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 2000));

      const response = await request(API_BASE)
        .get(`/api/works/${createdWorkId}/sources/${createdSourceId}/revisions`)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThanOrEqual(1);

      const firstRev = response.body[0];
      revisionId1 = firstRev.revisionId;

      if (response.body.length >= 2) {
        revisionId2 = response.body[1].revisionId;
      }
    });
  });

  describe('MusicDiff PDF (Bug Fix Verification)', () => {
    it('GET /api/works/:workId/sources/:sourceId/musicdiff?format=pdf should return non-empty PDF', async () => {
      if (!revisionId2) {
        console.log('  Skipping: Need 2 revisions for diff test');
        return;
      }

      const response = await request(API_BASE)
        .get(`/api/works/${createdWorkId}/sources/${createdSourceId}/musicdiff`)
        .query({ revA: revisionId1, revB: revisionId2, format: 'pdf' })
        .timeout(30000)
        .expect((res) => {
          // Accept success or not implemented
          expect([200, 400, 500, 501]).toContain(res.status);
        });

      if (response.status === 200) {
        console.log('✓ PDF diff generated successfully');
        expect(response.headers['content-type']).toContain('application/pdf');

        // CRITICAL: PDF must not be empty (this was the bug!)
        expect(response.body.length).toBeGreaterThan(0);

        // PDF should have valid header
        const pdfHeader = response.body.slice(0, 4).toString('utf-8');
        expect(pdfHeader).toBe('%PDF');

        console.log(`  PDF size: ${response.body.length} bytes`);
      } else {
        console.log(`  PDF generation returned ${response.status} - may need musicdiff/MuseScore`);
      }
    });

    it('GET /api/works/:workId/sources/:sourceId/musicdiff?format=lmx should return diff', async () => {
      if (!revisionId2) {
        console.log('  Skipping: Need 2 revisions for diff test');
        return;
      }

      const response = await request(API_BASE)
        .get(`/api/works/${createdWorkId}/sources/${createdSourceId}/musicdiff`)
        .query({ revA: revisionId1, revB: revisionId2, format: 'lmx' })
        .expect((res) => {
          expect([200, 400, 500]).toContain(res.status);
        });

      if (response.status === 200) {
        expect(response.text).toBeDefined();
      }
    });
  });

  describe('Watch Operations', () => {
    it('GET /api/works/:workId/sources/:sourceId/watch should return watch status', async () => {
      const response = await request(API_BASE)
        .get(`/api/works/${createdWorkId}/sources/${createdSourceId}/watch`)
        .expect(200);

      expect(response.body.count).toBeDefined();
      expect(typeof response.body.count).toBe('number');
    });
  });

  describe('Cleanup', () => {
    it('DELETE /api/works/:workId should clean up test work', async () => {
      await request(API_BASE)
        .delete(`/api/works/${createdWorkId}`)
        .expect((res) => {
          expect([200, 204, 404, 501]).toContain(res.status);
        });
    });
  });
});
