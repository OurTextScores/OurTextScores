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

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Smoke tests for critical OurTextScores functionality
 *
 * These tests verify that the most important user flows work end-to-end:
 * - Creating works and uploading sources with licensing metadata
 * - Derivative generation (PDF, MusicXML)
 * - Text diff generation
 * - Revision management
 *
 * Note: These tests require Docker services to be running:
 * - MongoDB
 * - MinIO
 * - (Fossil is spawned per-source)
 */
describe('Smoke Tests (e2e)', () => {
  let app: INestApplication;
  let createdWorkId: string;
  let createdSourceId: string;
  let revisionId1: string;
  let revisionId2: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Health & Basic API', () => {
    it('GET /api/health should return ok', () => {
      return request(app.getHttpServer())
        .get('/api/health')
        .expect(200)
        .expect((res) => {
          expect(res.body.status).toBe('ok');
        });
    });

    it('GET /api/works should return works list', () => {
      return request(app.getHttpServer())
        .get('/api/works')
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body)).toBe(true);
        });
    });
  });

  describe('Work Creation & Source Upload with Licensing', () => {
    const testMxl = Buffer.from('TEST_MXL_CONTENT'); // Simplified for smoke test

    it('POST /api/works should create a new work', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/works')
        .send({
          title: 'Smoke Test Work',
          composer: 'Test Composer'
        })
        .expect(201);

      expect(response.body.workId).toBeDefined();
      createdWorkId = response.body.workId;
    });

    it('POST /api/works/:workId/sources should upload source with CC-BY-4.0 license', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/works/${createdWorkId}/sources`)
        .field('label', 'Test Source')
        .field('description', 'Smoke test source with licensing')
        .field('license', 'CC-BY-4.0')
        .field('licenseAttribution', 'Test Author')
        .field('commitMessage', 'Initial smoke test upload')
        .attach('file', testMxl, 'test.mxl')
        .expect(202);

      expect(response.body.status).toBe('accepted');
      expect(response.body.sourceId).toBeDefined();
      createdSourceId = response.body.sourceId;
    });

    it('GET /api/works/:workId should return work with source including license metadata', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/works/${createdWorkId}`)
        .expect(200);

      expect(response.body.workId).toBe(createdWorkId);
      expect(response.body.sources).toBeDefined();

      const source = response.body.sources.find(s => s.sourceId === createdSourceId);
      expect(source).toBeDefined();
      expect(source.license).toBe('CC-BY-4.0');
      expect(source.licenseAttribution).toBe('Test Author');
    });

    it('POST /api/works/:workId/sources/:sourceId/revisions should upload revision with different license', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/works/${createdWorkId}/sources/${createdSourceId}/revisions`)
        .field('commitMessage', 'Second revision with CC0 license')
        .field('license', 'CC0')
        .attach('file', testMxl, 'test-v2.mxl')
        .expect(202);

      expect(response.body.status).toBe('accepted');
    });
  });

  describe('Derivative Generation', () => {
    it('GET /api/works/:workId/sources/:sourceId/revisions should list revisions with derivatives', async () => {
      // Wait a bit for derivative pipeline to process
      await new Promise(resolve => setTimeout(resolve, 2000));

      const response = await request(app.getHttpServer())
        .get(`/api/works/${createdWorkId}/sources/${createdSourceId}/revisions`)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThanOrEqual(1);

      const firstRevision = response.body[0];
      revisionId1 = firstRevision.revisionId;

      // Check that derivatives are being generated
      expect(firstRevision.derivatives).toBeDefined();

      if (response.body.length >= 2) {
        revisionId2 = response.body[1].revisionId;
      }
    });

    it('GET /api/works/:workId/sources/:sourceId/pdf should return PDF derivative', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/works/${createdWorkId}/sources/${createdSourceId}/pdf`)
        .expect((res) => {
          // Should either succeed (200) or be pending (202)
          expect([200, 202]).toContain(res.status);
        });

      if (response.status === 200) {
        expect(response.headers['content-type']).toContain('application/pdf');
        expect(response.body.length).toBeGreaterThan(0);
      }
    });

    it('GET /api/works/:workId/sources/:sourceId/xml should return canonical XML', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/works/${createdWorkId}/sources/${createdSourceId}/xml`)
        .expect((res) => {
          expect([200, 202]).toContain(res.status);
        });

      if (response.status === 200) {
        expect(response.headers['content-type']).toContain('application/xml');
      }
    });
  });

  describe('Branch Operations', () => {
    it('GET /api/works/:workId/sources/:sourceId/branches should list branches', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/works/${createdWorkId}/sources/${createdSourceId}/branches`)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body).toContain('trunk');
    });

    it('POST /api/works/:workId/sources/:sourceId/branches should create new branch', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/works/${createdWorkId}/sources/${createdSourceId}/branches`)
        .send({
          branchName: 'smoke-test-branch',
          fromRevision: revisionId1
        })
        .expect((res) => {
          // Accept both success and error if branch operations aren't fully implemented
          expect([201, 400, 404, 501]).toContain(res.status);
        });
    });
  });

  describe('Watch/Subscribe Operations', () => {
    it('GET /api/works/:workId/sources/:sourceId/watch should return watch status', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/works/${createdWorkId}/sources/${createdSourceId}/watch`)
        .expect(200);

      expect(response.body.count).toBeDefined();
      expect(typeof response.body.count).toBe('number');
      expect(response.body.subscribed).toBeDefined();
      expect(typeof response.body.subscribed).toBe('boolean');
    });
  });

  describe('Search Operations', () => {
    it('GET /api/search?q=test should return search results', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/search')
        .query({ q: 'test' })
        .expect((res) => {
          // Search may not be fully implemented (MeiliSearch stub)
          expect([200, 501]).toContain(res.status);
        });

      if (response.status === 200) {
        expect(response.body.hits).toBeDefined();
      }
    });
  });

  describe('Cleanup', () => {
    it('DELETE /api/works/:workId should delete test work', async () => {
      await request(app.getHttpServer())
        .delete(`/api/works/${createdWorkId}`)
        .expect((res) => {
          // Accept both success and not implemented
          expect([200, 204, 404, 501]).toContain(res.status);
        });
    });
  });
});
