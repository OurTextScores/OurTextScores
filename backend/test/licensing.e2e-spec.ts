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
 * Tests for User Content Licensing Feature
 *
 * This test suite verifies the dual licensing implementation:
 * - Platform code: AGPL-3.0
 * - User content: Configurable per source (CC licenses, Public Domain, etc.)
 *
 * Features tested:
 * - Uploading sources with license metadata
 * - Storing license, licenseUrl, and licenseAttribution
 * - Retrieving license information via API
 * - Different license options (CC0, CC-BY-4.0, etc.)
 */
describe('User Content Licensing (e2e)', () => {
  let app: INestApplication;
  let testWorkId: string;

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

  beforeEach(async () => {
    // Create a fresh work for each test
    const response = await request(app.getHttpServer())
      .post('/api/works')
      .send({
        title: 'Licensing Test Work',
        composer: 'Test Composer'
      })
      .expect(201);

    testWorkId = response.body.workId;
  });

  describe('CC0 - Public Domain Dedication', () => {
    it('should accept and store CC0 license', async () => {
      const sampleFile = Buffer.from('TEST_CONTENT');
      const response = await request(app.getHttpServer())
        .post(`/api/works/${testWorkId}/sources`)
        .field('label', 'CC0 Test Source')
        .field('license', 'CC0')
        .attach('file', sampleFile, 'test.mxl')
        .expect(202);

      const sourceId = response.body.sourceId;

      // Verify license is stored
      const workResponse = await request(app.getHttpServer())
        .get(`/api/works/${testWorkId}`)
        .expect(200);

      const source = workResponse.body.sources.find(s => s.sourceId === sourceId);
      expect(source.license).toBe('CC0');
    });
  });

  describe('CC-BY-4.0 - Attribution', () => {
    it('should accept CC-BY-4.0 with attribution', async () => {
      const sampleFile = Buffer.from('TEST_CONTENT');
      const response = await request(app.getHttpServer())
        .post(`/api/works/${testWorkId}/sources`)
        .field('label', 'CC-BY Test Source')
        .field('license', 'CC-BY-4.0')
        .field('licenseAttribution', 'Jane Doe')
        .attach('file', sampleFile, 'test.mxl')
        .expect(202);

      const sourceId = response.body.sourceId;

      // Verify license and attribution are stored
      const workResponse = await request(app.getHttpServer())
        .get(`/api/works/${testWorkId}`)
        .expect(200);

      const source = workResponse.body.sources.find(s => s.sourceId === sourceId);
      expect(source.license).toBe('CC-BY-4.0');
      expect(source.licenseAttribution).toBe('Jane Doe');
    });
  });

  describe('CC-BY-SA-4.0 - Attribution-ShareAlike', () => {
    it('should accept CC-BY-SA-4.0 license', async () => {
      const sampleFile = Buffer.from('TEST_CONTENT');
      const response = await request(app.getHttpServer())
        .post(`/api/works/${testWorkId}/sources`)
        .field('label', 'CC-BY-SA Test Source')
        .field('license', 'CC-BY-SA-4.0')
        .field('licenseAttribution', 'John Smith')
        .attach('file', sampleFile, 'test.mxl')
        .expect(202);

      const sourceId = response.body.sourceId;

      const workResponse = await request(app.getHttpServer())
        .get(`/api/works/${testWorkId}`)
        .expect(200);

      const source = workResponse.body.sources.find(s => s.sourceId === sourceId);
      expect(source.license).toBe('CC-BY-SA-4.0');
      expect(source.licenseAttribution).toBe('John Smith');
    });
  });

  describe('CC-BY-NC-4.0 - Attribution-NonCommercial', () => {
    it('should accept CC-BY-NC-4.0 license', async () => {
      const sampleFile = Buffer.from('TEST_CONTENT');
      const response = await request(app.getHttpServer())
        .post(`/api/works/${testWorkId}/sources`)
        .field('label', 'CC-BY-NC Test Source')
        .field('license', 'CC-BY-NC-4.0')
        .field('licenseAttribution', 'Attribution Text')
        .attach('file', sampleFile, 'test.mxl')
        .expect(202);

      const sourceId = response.body.sourceId;

      const workResponse = await request(app.getHttpServer())
        .get(`/api/works/${testWorkId}`)
        .expect(200);

      const source = workResponse.body.sources.find(s => s.sourceId === sourceId);
      expect(source.license).toBe('CC-BY-NC-4.0');
    });
  });

  describe('Public Domain', () => {
    it('should accept Public Domain license', async () => {
      const sampleFile = Buffer.from('TEST_CONTENT');
      const response = await request(app.getHttpServer())
        .post(`/api/works/${testWorkId}/sources`)
        .field('label', 'Public Domain Test Source')
        .field('license', 'Public Domain')
        .attach('file', sampleFile, 'test.mxl')
        .expect(202);

      const sourceId = response.body.sourceId;

      const workResponse = await request(app.getHttpServer())
        .get(`/api/works/${testWorkId}`)
        .expect(200);

      const source = workResponse.body.sources.find(s => s.sourceId === sourceId);
      expect(source.license).toBe('Public Domain');
    });
  });

  describe('All Rights Reserved', () => {
    it('should accept All Rights Reserved (copyright)', async () => {
      const sampleFile = Buffer.from('TEST_CONTENT');
      const response = await request(app.getHttpServer())
        .post(`/api/works/${testWorkId}/sources`)
        .field('label', 'Copyright Test Source')
        .field('license', 'All Rights Reserved')
        .attach('file', sampleFile, 'test.mxl')
        .expect(202);

      const sourceId = response.body.sourceId;

      const workResponse = await request(app.getHttpServer())
        .get(`/api/works/${testWorkId}`)
        .expect(200);

      const source = workResponse.body.sources.find(s => s.sourceId === sourceId);
      expect(source.license).toBe('All Rights Reserved');
    });
  });

  describe('Other - Custom License', () => {
    it('should accept Other license with custom URL', async () => {
      const sampleFile = Buffer.from('TEST_CONTENT');
      const response = await request(app.getHttpServer())
        .post(`/api/works/${testWorkId}/sources`)
        .field('label', 'Custom License Test Source')
        .field('license', 'Other')
        .field('licenseUrl', 'https://example.com/custom-license')
        .attach('file', sampleFile, 'test.mxl')
        .expect(202);

      const sourceId = response.body.sourceId;

      const workResponse = await request(app.getHttpServer())
        .get(`/api/works/${testWorkId}`)
        .expect(200);

      const source = workResponse.body.sources.find(s => s.sourceId === sourceId);
      expect(source.license).toBe('Other');
      expect(source.licenseUrl).toBe('https://example.com/custom-license');
    });
  });

  describe('No License Specified', () => {
    it('should accept upload without license metadata', async () => {
      const sampleFile = Buffer.from('TEST_CONTENT');
      const response = await request(app.getHttpServer())
        .post(`/api/works/${testWorkId}/sources`)
        .field('label', 'No License Test Source')
        .attach('file', sampleFile, 'test.mxl')
        .expect(202);

      const sourceId = response.body.sourceId;

      const workResponse = await request(app.getHttpServer())
        .get(`/api/works/${testWorkId}`)
        .expect(200);

      const source = workResponse.body.sources.find(s => s.sourceId === sourceId);
      // License fields should be undefined or null
      expect(source.license).toBeUndefined();
    });
  });

  describe('License Changes on Revisions', () => {
    it('should allow changing license on new revision', async () => {
      const sampleFile1 = Buffer.from('TEST_V1');
      const sampleFile2 = Buffer.from('TEST_V2');

      // Upload with CC0
      const uploadResponse = await request(app.getHttpServer())
        .post(`/api/works/${testWorkId}/sources`)
        .field('label', 'License Change Test')
        .field('license', 'CC0')
        .attach('file', sampleFile1, 'test-v1.mxl')
        .expect(202);

      const sourceId = uploadResponse.body.sourceId;

      // Upload revision with CC-BY-4.0
      await request(app.getHttpServer())
        .post(`/api/works/${testWorkId}/sources/${sourceId}/revisions`)
        .field('license', 'CC-BY-4.0')
        .field('licenseAttribution', 'New Author')
        .attach('file', sampleFile2, 'test-v2.mxl')
        .expect(202);

      // Verify source now has CC-BY-4.0
      const workResponse = await request(app.getHttpServer())
        .get(`/api/works/${testWorkId}`)
        .expect(200);

      const source = workResponse.body.sources.find(s => s.sourceId === sourceId);
      expect(source.license).toBe('CC-BY-4.0');
      expect(source.licenseAttribution).toBe('New Author');
    });
  });

  describe('License Persistence Across Endpoints', () => {
    it('should persist license metadata across different API endpoints', async () => {
      const sampleFile = Buffer.from('TEST_CONTENT');
      const response = await request(app.getHttpServer())
        .post(`/api/works/${testWorkId}/sources`)
        .field('label', 'Persistence Test')
        .field('license', 'CC-BY-SA-4.0')
        .field('licenseAttribution', 'Test Attribution')
        .attach('file', sampleFile, 'test.mxl')
        .expect(202);

      const sourceId = response.body.sourceId;

      // Check via /api/works/:workId
      const work1 = await request(app.getHttpServer())
        .get(`/api/works/${testWorkId}`)
        .expect(200);

      let source = work1.body.sources.find(s => s.sourceId === sourceId);
      expect(source.license).toBe('CC-BY-SA-4.0');
      expect(source.licenseAttribution).toBe('Test Attribution');

      // Check via /api/works (list endpoint)
      const worksList = await request(app.getHttpServer())
        .get('/api/works')
        .expect(200);

      const workFromList = worksList.body.find(w => w.workId === testWorkId);
      expect(workFromList).toBeDefined();

      // License info should be available in source listings
      source = workFromList.sources.find(s => s.sourceId === sourceId);
      expect(source.license).toBe('CC-BY-SA-4.0');
    });
  });
});
